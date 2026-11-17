/** Reviewed immutable model assets; downloads occur only after explicit setup. */
export const retrievalModel = {
  id: "onnx-community/Qwen2.5-Coder-0.5B-Instruct",
  revision: "604bb1988ff789d5024d589c63cf9ae81c0c8ab5",
  dtype: "q4",
  runtimeVersion: "4.3.2",
  license: "Apache-2.0",
  source: "https://huggingface.co/onnx-community/Qwen2.5-Coder-0.5B-Instruct/tree/604bb1988ff789d5024d589c63cf9ae81c0c8ab5",
  assets: [
    { name: "config.json", bytes: 916, sha256: "0cc602159ab086bffa8500296b95f067dfc6b690863f7393b3ac5c82137c059b" },
    { name: "generation_config.json", bytes: 243, sha256: "519a8db66fcfd0d18731eb75169ff8393a6f9c479fd50142fb5ee2580bb9ae64" },
    { name: "tokenizer_config.json", bytes: 7849, sha256: "6a14243f0ae04884e597b3f032c05e15de9f417318fdcac24ab4e2680e691430" },
    { name: "tokenizer.json", bytes: 11421896, sha256: "9c5ae00e602b8860cbd784ba82a8aa14e8feecec692e7076590d014d7b7fdafa" },
    { name: "onnx/model_q4.onnx", bytes: 862087110, sha256: "2df7ea9739c3c26bd9d2cad0815768a5a0a985d4b5548b7de80c5e85e9a97b47" },
    { name: "README.md", bytes: 2714, sha256: "2d845a059c74894bbbf7f66d704eb1f98404c5aeb1bec32cd79d82b415f5dcdc" },
    { name: "LICENSE", bytes: 11343, sha256: "832dd9e00a68dd83b3c3fb9f5588dad7dcf337a0db50f7d9483f310cd292e92e", sourceUrl: "https://huggingface.co/Qwen/Qwen2.5-Coder-0.5B-Instruct/resolve/ea3f2471cf1b1f0db85067f1ef93848e38e88c25/LICENSE" },
  ],
} as const;

export const retrievalSetupDownloadBytes = retrievalModel.assets.reduce((sum, asset) => sum + asset.bytes, 0);

export function retrievalAssetUrl(asset: { name: string; url?: string }): string {
  return asset.url ?? `https://d12b8r6xagt10r.cloudfront.net/releases/local-models/retrieval/${retrievalModel.revision}/${asset.name}`;
}
