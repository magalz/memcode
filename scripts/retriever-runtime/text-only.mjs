// MemCode's local retrieval helper accepts text generation only. Image, audio
// and document pipelines are deliberately outside this runtime's contract.
import {pipeline as createPipeline, env} from './node_modules/@huggingface/transformers/dist/transformers.node.mjs';
export {env};
export function pipeline(task, model, options) {
  if (task !== 'text-generation') throw Error('The MemCode retrieval runtime supports text generation only.');
  return createPipeline(task, model, options);
}
