---
'bonsai-js': minor
---

Add `bonsai-js/runtime` and `toArtifact()`: check and compile rules where the full toolchain runs, and evaluate them in the browser without the checker (about 44 KB minified and gzipped), with exactly the results the compiled programs give. A runtime whose definitions differ refuses an artifact with `BonsaiArtifactError` (code `ARTIFACT`) and a `reason`.
