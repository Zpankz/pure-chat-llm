import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DurableTaskList } from '../../../src/harness/durableTasks';

test('durable workers show up, finish, fail and can be stopped', async () => {
  const aborted: number[] = [];
  const list = new DurableTaskList(
    async id => {
      aborted.push(id);
    },
    () => 'gpt-test',
  );
  let changes = 0;
  list.onChange(() => changes++);
  list.record({ conversation: '1', id: 't1', title: 'Find notes', status: 'running', taskId: 7 });
  list.record({ conversation: '1', id: 't2', title: 'Sum up', status: 'running', taskId: 8 });
  assert.equal(list.list().length, 2);
  assert.equal(list.find('find notes')?.id, 't1');
  assert.match(list.cancel('t1'), /Stopping t1/);
  assert.deepEqual(aborted, [7]);
  list.record({ conversation: '1', id: 't1', title: 'Find notes', status: 'cancelled' });
  assert.match(list.cancel('t1'), /already cancelled/);
  list.record({ conversation: '1', id: 't2', title: 'Sum up', status: 'failed', text: 'No key' });
  assert.equal(list.find('t2')?.error, 'No key');
  assert.ok(list.find('t2')?.finishedAt);
  assert.equal(changes, 4);
  assert.match(list.cancel('t9'), /No task matches/);
});
