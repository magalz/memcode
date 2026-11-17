# Third-party source access

MemCode's original code is licensed separately from these components. The
noncommercial restriction does not apply to their independently granted rights.
The unmodified MPL-2.0 components remain available under MPL-2.0; the full
[license text](license-texts/MPL-2.0.txt) and original notices accompany MemCode.

| Ecosystem | Component | Version | Source |
| --- | --- | --- | --- |
| cargo | cssparser-macros | 0.7.1 | [Preferred source form](https://crates.io/api/v1/crates/cssparser-macros/0.7.1/download) |
| cargo | cssparser | 0.37.0 | [Preferred source form](https://crates.io/api/v1/crates/cssparser/0.37.0/download) |
| cargo | cssparser | 0.38.0 | [Preferred source form](https://crates.io/api/v1/crates/cssparser/0.38.0/download) |
| cargo | dtoa-short | 0.3.5 | [Preferred source form](https://crates.io/api/v1/crates/dtoa-short/0.3.5/download) |
| cargo | option-ext | 0.2.0 | [Preferred source form](https://crates.io/api/v1/crates/option-ext/0.2.0/download) |
| cargo | selectors | 0.38.0 | [Preferred source form](https://crates.io/api/v1/crates/selectors/0.38.0/download) |
| cargo | selectors | 0.41.0 | [Preferred source form](https://crates.io/api/v1/crates/selectors/0.41.0/download) |
| npm | mtx-decompressor | 1.8.1 | [Preferred source form](https://github.com/ChristopherVR/mtx-decompressor/tree/d4a554a4ea8126aac0ab00a1fe8253e0ffd316d4) |

The mtx-decompressor link identifies the exact upstream source commit recorded
in npm metadata for 1.8.1. Cargo links provide complete exact-version source
archives, including the files in their preferred form for modification.

## Liberation font source

PDF.js's Liberation Sans files identify themselves as version 1.07.4. The
corresponding SFD source, FontForge scripts and build instructions are supplied
in [liberation-fonts-1.07.4.tar.gz](sources/liberation-fonts-1.07.4.tar.gz).
They retain the [original GPL v2 font terms and exceptions](licenses/npm/pdfjs-dist-6.5.438/standard_fonts/LICENSE_LIBERATION).
The archive is unmodified and its SHA-256 matches the original-source checksum
in the Debian source descriptor linked from [resources.json](resources.json).
These font rights include modification and replacement; MemCode's separate
license does not narrow those rights.

Memtrace/MemDB proprietary engine source is not included by this source-access
notice. Node is distributed with its complete separate NODE-LICENSE in the
desktop-runtime resources; operating-system browser/credential services retain
their own applicable terms.

## Optional text-only inference

The separately supplied local inference resources retain their own original
licenses and notices. Exact upstream sources are available for
[Transformers.js 4.3.2](https://github.com/huggingface/transformers.js/tree/4.3.2)
and [ONNX Runtime 1.23.2](https://github.com/microsoft/onnxruntime/tree/v1.23.2).
The text-only Transformers.js build is identified as modified in the runtime
provenance; it excludes Sharp and libvips. The staged runtime's notice inventory
and original npm package declarations identify its remaining components.
