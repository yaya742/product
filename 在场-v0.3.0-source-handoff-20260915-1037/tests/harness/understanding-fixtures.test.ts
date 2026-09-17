import test from 'node:test';
import { understandingCases } from './understanding-cases';
import { setupUnderstanding } from './understanding-fixtures';
import { newUnderstandingStories } from './understanding-new-stories';

test('all frozen public story environments initialize without a model or private data', async () => {
  for (const story of [...understandingCases, ...newUnderstandingStories]) {
    try { const fixture = await setupUnderstanding(story); await fixture.close(); }
    catch (error) { throw new Error(story.id + ': ' + (error instanceof Error ? error.stack : String(error))); }
  }
});
