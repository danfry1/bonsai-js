---
'bonsai-js': patch
---

Check errors for a non-boolean in a condition, `!`, `&&` or `||` now say how to fix it. A default written with `||` (`user.nickname || "anon"`, or `discount || 0` on an untyped value) is reported once, suggesting `??`, and the rest of the expression is checked as if it used `??`, so a method call on it adds no further error. Where a boolean is wanted (a condition, `!`, `&&`), a number or string is told to compare it (`x != 0`), or to test it against null (`x != null`) when it may be null.
