---
'bonsai-js': patch
---

Check errors for a non-boolean in a condition, `!`, `&&` or `||` now say how to fix it. A value that may be null before `||` (`user.nickname || "anon"`) is reported once, suggesting `??`, instead of once for each side. A number or string gets the explicit comparison the runtime error already suggests (`x != 0`).
