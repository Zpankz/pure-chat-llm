import { FuzzySuggestModal, Notice, TFile, type App } from 'obsidian';
import { reviewProposal } from '../tools/EditReview';
import { toolErrorMessage } from '../tools/toolContract';

/** Frontmatter key that marks a background task's proposal note. */
const PROPOSAL_KEY = 'voice-agent-proposal';

/**
 * Pending proposals from background tasks: changes a worker wanted to make while the write policy
 * was "ask me", saved as notes instead of applied.
 * @param app - App.
 */
export function pendingProposals(app: App): TFile[] {
  return app.vault
    .getMarkdownFiles()
    .filter(file => {
      const fm = app.metadataCache.getFileCache(file)?.frontmatter;
      return !!fm?.[PROPOSAL_KEY] && fm.status === 'pending';
    })
    .sort((a, b) => b.stat.mtime - a.stat.mtime);
}

/** Lists pending proposals; the one picked opens in the review window and is applied on approval. */
export class ProposalPicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private proposals: TFile[],
  ) {
    super(app);
    this.setPlaceholder('Pick a proposed change to review');
  }

  getItems(): TFile[] {
    return this.proposals;
  }

  getItemText(file: TFile): string {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const target = typeof fm.target === 'string' ? fm.target : '';
    const action = typeof fm[PROPOSAL_KEY] === 'string' ? (fm[PROPOSAL_KEY]) : 'change';
    return target ? `${action}: ${target.replace(/^\[\[|\]\]$/g, '')}` : file.basename;
  }

  onChooseItem(file: TFile): void {
    void reviewProposal(this.app, file.path).then(outcome => {
      if (!outcome.ok)
        new Notice(toolErrorMessage(outcome.error ?? 'The proposal could not be reviewed.'));
      else if (outcome.applied) new Notice(`Applied the proposed change to ${outcome.path}.`);
      else new Notice('Left the note unchanged.');
    });
  }
}
