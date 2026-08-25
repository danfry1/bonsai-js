import type { ASTNode, BonsaiObjectType, BonsaiType } from '../types.js'

export type CheckDiagnosticCode =
  | 'SYNTAX_ERROR'
  | 'RESOURCE_LIMIT'
  | 'UNKNOWN_IDENTIFIER'
  | 'UNKNOWN_PROPERTY'
  | 'UNKNOWN_FUNCTION'
  | 'UNKNOWN_TRANSFORM'
  | 'TYPE_MISMATCH'
  | 'ARGUMENT_COUNT'
  | 'METHOD_NOT_ALLOWED'
  | 'NULLABLE_ACCESS'
  | 'EXPECTED_RESULT'
  | 'PROPERTY_NOT_ALLOWED'

export interface CheckDiagnostic {
  readonly code: CheckDiagnosticCode
  readonly message: string
  readonly severity: 'error'
  readonly start: number
  readonly end: number
}

export interface CheckOptions {
  /**
   * Static shape of the evaluation context (root identifiers and their types).
   * The same descriptor can be passed to `createAutocomplete(instance, { schema })`.
   */
  readonly schema?: BonsaiObjectType
  /** Required result type. */
  readonly expectedType?: BonsaiType
  /** Treat undeclared root identifiers as unknown instead of reporting them. */
  readonly allowUnknownIdentifiers?: boolean
}

export type CheckResult =
  | {
      readonly valid: true
      readonly type: BonsaiType
      readonly diagnostics: readonly []
      readonly ast: ASTNode
    }
  | {
      readonly valid: false
      readonly type: BonsaiType
      readonly diagnostics: readonly CheckDiagnostic[]
      readonly ast?: ASTNode
    }

export type CheckerOptions = CheckOptions

export interface BonsaiChecker {
  check: (expression: string, options?: CheckOptions) => CheckResult
}
