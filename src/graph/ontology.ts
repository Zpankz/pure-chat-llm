import type { App } from 'obsidian';
import { TFile } from 'obsidian';
import { inFolders, resolveFolders } from '../utils/vaultResolve';
import type { VaultGraph } from './VaultGraph';

/** Filters shared by graph tools. */
export interface GraphScope {
  folder?: string;
  tag?: string;
  nodeTypes?: string[];
}

/**
 * Turns folder, tag and node-type filters into one predicate. Returns an error message when a
 * folder can't be found.
 * @param app - Obsidian app.
 * @param graph - Vault graph.
 * @param scope - Filters.
 */
export function scopeFilter(
  app: App,
  graph: VaultGraph,
  scope: GraphScope,
): { keep: (path: string) => boolean; label: string; error?: string } {
  const parts: string[] = [];
  let folders: ReturnType<typeof resolveFolders> | null = null;
  if (scope.folder?.trim()) {
    folders = resolveFolders(app, scope.folder);
    if (!folders.length) {
      return { keep: () => false, label: '', error: `No folder named or at "${scope.folder}".` };
    }
    parts.push(`in ${folders.map(f => f.path || '/').join(', ')}`);
  }
  if (scope.tag?.trim()) parts.push(`tagged #${scope.tag.replace(/^#/, '')}`);
  const types = (scope.nodeTypes ?? []).filter(Boolean);
  if (types.length) parts.push(`of type ${types.join(' or ')}`);
  const keep = (path: string) => {
    if (folders) {
      const f = app.vault.getAbstractFileByPath(path);
      if (!(f instanceof TFile) || !inFolders(f, folders)) return false;
    }
    if (scope.tag?.trim() && !graph.hasTag(path, scope.tag)) return false;
    if (types.length && !graph.hasType(path, types)) return false;
    return true;
  };
  return { keep, label: parts.join(', ') };
}

/**
 * Describes the vault's typed ontology for an agent: declared node and edge types (from Typed
 * Graph schema notes), what is actually used, tags and frontmatter properties.
 * @param graph - Vault graph.
 * @param compact - A short version for system prompts.
 */
export function ontologySummary(graph: VaultGraph, compact = false): string {
  const lines: string[] = [];
  const declaredEdges = [...graph.schema.edgeTypes.values()];
  const declaredNodes = [...graph.schema.nodeTypes.values()];
  const used = graph.edgeTypes();
  const usedCount = new Map(used.map(u => [u.type, u.count]));
  const nodeCounts = graph.typeCounts();
  const nodeCount = new Map(nodeCounts.map(n => [n.type, n.notes]));

  lines.push(
    `VAULT ONTOLOGY: ${graph.paths.length} notes, ${used.reduce((n, u) => n + u.count, 0)} typed links.`,
  );
  if (graph.schema.sources.length) {
    lines.push(`Schema notes (Typed Graph): ${graph.schema.sources.join(', ')}`);
  }

  if (declaredEdges.length) {
    lines.push('', 'Edge types (frontmatter properties that link notes):');
    const max = compact ? 25 : 200;
    for (const e of declaredEdges.slice(0, max)) {
      const range = `${short(e.from, compact)} -> ${short(e.to, compact)}`;
      const desc = compact ? firstSentence(e.description, 110) : e.description;
      lines.push(`- ${e.name} (${usedCount.get(e.name) ?? 0} links; ${range}): ${desc}`);
    }
    const undeclared = used.filter(
      u => !graph.schema.edgeTypes.has(u.type) && u.type !== 'link' && u.type !== 'embed',
    );
    if (undeclared.length)
      lines.push(
        `- Also used, not declared: ${undeclared
          .slice(0, 15)
          .map(u => `${u.type} (${u.count})`)
          .join(', ')}`,
      );
  } else if (used.length) {
    lines.push('', 'Link types in use (no schema notes found):');
    for (const u of used.slice(0, compact ? 15 : 60)) lines.push(`- ${u.type}: ${u.count}`);
  }
  const plain = used.filter(u => u.type === 'link' || u.type === 'embed');
  if (plain.length)
    lines.push(`- Untyped: ${plain.map(u => `${u.type} ${u.count}`).join(', ')} (body links)`);

  if (declaredNodes.length || nodeCounts.length) {
    lines.push('', 'Node types (frontmatter `type`):');
    const names = new Set([...declaredNodes.map(n => n.name), ...nodeCounts.map(n => n.type)]);
    const sorted = [...names].sort((a, b) => (nodeCount.get(b) ?? 0) - (nodeCount.get(a) ?? 0));
    if (compact) {
      lines.push(
        sorted
          .slice(0, 40)
          .map(n => `${n} (${nodeCount.get(n) ?? 0})`)
          .join(', '),
      );
    } else {
      for (const n of sorted) {
        const d = graph.schema.nodeTypes.get(n);
        const edges = d?.edges.length ? ` Edges: ${d.edges.join(', ')}.` : '';
        lines.push(
          `- ${n} (${nodeCount.get(n) ?? 0} notes)${d ? `: ${firstSentence(d.description, 220)}${edges}` : ''}`,
        );
      }
    }
  }

  const tags = graph.tagCounts();
  if (tags.length) {
    lines.push(
      '',
      `Tags: ${tags
        .slice(0, compact ? 15 : 50)
        .map(t => `#${t.tag} (${t.notes})`)
        .join(', ')}`,
    );
  }
  if (!compact && graph.properties.size) {
    const props = [...graph.properties.entries()].sort((a, b) => b[1].notes - a[1].notes);
    lines.push(
      '',
      `Frontmatter properties: ${props
        .slice(0, 60)
        .map(([k, v]) => `${k} (${v.notes}, ${[...v.kinds].join('/')})`)
        .join(', ')}`,
    );
  }
  lines.push(
    '',
    compact
      ? 'Follow typed edges with traverse_graph (edge_types, node_types, folder, tag) or graph_cli; call vault_ontology for the full schema.'
      : 'Use edge type names in traverse_graph `edge_types` or graph_cli commands to follow only those relations; filter notes with `node_types`, `folder` and `tag`.',
  );
  return lines.join('\n');
}

function short(list: string[], compact: boolean): string {
  if (!list.length) return 'any';
  if (!compact || list.length <= 4) return list.join('|');
  return `${list.slice(0, 3).join('|')}|+${list.length - 3}`;
}

function firstSentence(text: string, max: number): string {
  const end = text.search(/\.\s/);
  const s = end >= 0 ? text.slice(0, end + 1) : text;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
