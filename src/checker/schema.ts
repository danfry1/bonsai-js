// The static type vocabulary lives in src/static-types.ts so the core package
// can export `t` for extension metadata; the checker re-exports it here.
export {
  t,
  unionOf,
  formatType,
  isAssignable,
  fromInferredTypeName,
  literalBaseKind,
} from '../static-types.js'
