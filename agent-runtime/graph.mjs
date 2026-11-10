import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

const GraphState = Annotation.Root({
  run: Annotation(),
});

// The caller persists each state before invoking a model or an external tool.
export function createExecutionGraph({ model, executeTool, checkpoint, authorize }) {
  const graph = new StateGraph(GraphState)
    .addNode('model', async ({ run }) => {
      if (run.turns >= run.maxTurns) return { run: { ...run, status: 'exhausted' } };
      await checkpoint(run);
      const turn = await model(run);
      const next = { ...run, ...turn.state, turns: run.turns + 1, pending: turn.calls || [], output: turn.output, status: turn.calls?.length ? 'running' : 'finished' };
      await checkpoint(next);
      return { run: next };
    })
    .addNode('tools', async ({ run }) => {
      const call = run.pending[0];
      if (!await authorize(call, run)) {
        const paused = { ...run, status: 'waiting' };
        await checkpoint(paused);
        return { run: paused };
      }
      await checkpoint(run);
      const result = await executeTool(call, run);
      const next = { ...run, ...result.state, pending: run.pending.slice(1), output: result.output ?? run.output, status: result.done ? 'finished' : 'running' };
      await checkpoint(next);
      return { run: next };
    })
    .addConditionalEdges(START, ({ run }) => run.status === 'finished' ? END : run.pending?.length ? 'tools' : 'model')
    .addConditionalEdges('model', ({ run }) => run.status === 'exhausted' || !run.pending.length ? END : 'tools')
    .addConditionalEdges('tools', ({ run }) => run.status !== 'running' ? END : run.pending.length ? 'tools' : 'model');
  return graph.compile();
}
