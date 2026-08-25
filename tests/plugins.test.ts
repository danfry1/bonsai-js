import { describe, it, expect } from 'vitest'
import { createPluginRegistry } from '../src/plugins.js'

describe('plugin registry', () => {
  it('should register and retrieve transforms', () => {
    const registry = createPluginRegistry()
    registry.addTransform('upper', (val: unknown) => (val as string).toUpperCase())
    expect(registry.getTransform('upper')).toBeDefined()
  })

  it('should register and retrieve functions', () => {
    const registry = createPluginRegistry()
    registry.addFunction('now', () => Date.now())
    expect(registry.getFunction('now')).toBeDefined()
  })

  it('should apply plugins via use()', () => {
    const registry = createPluginRegistry()
    const myPlugin = (r: typeof registry) => {
      r.addTransform('double', (val: unknown) => (val as number) * 2)
      r.addFunction('greet', () => 'hello')
    }
    registry.use(myPlugin)
    expect(registry.getTransform('double')).toBeDefined()
    expect(registry.getFunction('greet')).toBeDefined()
  })

  it('should list all transform names', () => {
    const registry = createPluginRegistry()
    registry.addTransform('upper', (v: unknown) => v)
    registry.addTransform('lower', (v: unknown) => v)
    expect(registry.getTransformNames()).toEqual(['upper', 'lower'])
  })

  it('should list all function names', () => {
    const registry = createPluginRegistry()
    registry.addFunction('now', () => 0)
    expect(registry.getFunctionNames()).toEqual(['now'])
  })

  it('rejects unreachable, unsafe, and non-callable bindings', () => {
    const registry = createPluginRegistry()
    const noop = (value: unknown) => value

    for (const name of ['constructor', 'prototype', '__proto__', 'true', 'has space', '1st']) {
      expect(() => {
        registry.addFunction(name, noop)
      }).toThrow(TypeError)
      expect(() => {
        registry.addTransform(name, noop)
      }).toThrow(TypeError)
    }

    expect(() => {
      registry.addFunction('broken', null as unknown as (...args: unknown[]) => unknown)
    }).toThrow(TypeError)
    expect(() => {
      registry.use(null as unknown as (r: typeof registry) => void)
    }).toThrow(TypeError)
  })

  it('accepts every identifier form supported by the lexer', () => {
    const registry = createPluginRegistry()
    registry.addFunction('_private', () => 1)
    registry.addTransform('$format2', (value) => value)
    expect(registry.getFunction('_private')).toBeDefined()
    expect(registry.getTransform('$format2')).toBeDefined()
  })

  it('normalizes and validates transform metadata', () => {
    const registry = createPluginRegistry()
    const inputType = { kind: 'string' } as const
    registry.addTransform('upper', (value) => value, {
      inputType,
      returnType: { kind: 'string' },
      arrayTypeRule: 'preserve',
      description: 'Uppercase text',
    })
    const metadata = registry.getTransformMetadata('upper')

    expect(metadata).toEqual({
      inputType: { kind: 'string' },
      returnType: { kind: 'string' },
      arrayTypeRule: 'preserve',
      description: 'Uppercase text',
    })
    expect(Object.isFrozen(metadata)).toBe(true)
    expect(metadata?.inputType).not.toBe(inputType)
    expect(Object.isFrozen(metadata?.inputType)).toBe(true)
    expect(() => {
      registry.addTransform('bad', (value) => value, {
        returnType: { kind: 'wat' } as unknown as { kind: 'string' },
      })
    }).toThrow(TypeError)
    expect(() => {
      registry.addTransform('badLiteral', (value) => value, {
        returnType: { kind: 'literal', value: Number.NaN },
      })
    }).toThrow(TypeError)
    expect(() => {
      registry.addTransform('badRule', (value) => value, {
        arrayTypeRule: 'mystery' as 'map',
      })
    }).toThrow(/arrayTypeRule/u)
  })

  it('validates and freezes precise static signatures', () => {
    const registry = createPluginRegistry()
    registry.addFunction('between', () => true, {
      parameters: [
        { name: 'value', type: { kind: 'number' } },
        { name: 'max', type: { kind: 'number' }, optional: true },
      ],
      returnType: { kind: 'boolean' },
    })
    const metadata = registry.getFunctionMetadata('between')

    expect(Object.isFrozen(metadata?.parameters)).toBe(true)
    expect(Object.isFrozen(metadata?.parameters?.[0])).toBe(true)
    expect(Object.isFrozen(metadata?.returnType)).toBe(true)
    expect(() => {
      registry.addFunction('badOrder', () => true, {
        parameters: [
          { name: 'optional', type: { kind: 'number' }, optional: true },
          { name: 'required', type: { kind: 'number' } },
        ],
      })
    }).toThrow(/required parameters/u)
    expect(() => {
      registry.addTransform('badType', (value) => value, {
        returnType: { kind: 'invalid' } as never,
      })
    }).toThrow(/unknown static type kind/u)
  })

  it('freezes snapshots and refuses mutation after sealing', () => {
    const registry = createPluginRegistry()
    registry.addFunction('one', () => 1)
    const bindings = registry.bindings
    registry.seal()

    expect(registry.isSealed()).toBe(true)
    expect(Object.isFrozen(bindings)).toBe(true)
    expect(Object.isFrozen(bindings.functions)).toBe(true)
    expect(() => {
      registry.addFunction('two', () => 2)
    }).toThrow(/sealed/u)
    expect(() => {
      registry.removeFunction('one')
    }).toThrow(/sealed/u)
  })

  it('rejects accidental collisions and provides explicit replacement', () => {
    const registry = createPluginRegistry()
    registry.addTransform('value', () => 1)
    registry.addFunction('call', () => 1)

    expect(() => {
      registry.addTransform('value', () => 2)
    }).toThrow(/already registered/u)
    expect(() => {
      registry.addContextFunction('call', () => 2)
    }).toThrow(/already registered/u)
    registry.replaceTransform('value', () => 2)
    registry.replaceContextFunction('call', () => 2)
    expect(registry.getTransform('value')?.(null)).toBe(2)
    expect(registry.isContextFunction('call')).toBe(true)
    expect(() => {
      registry.replaceFunction('missing', () => 1)
    }).toThrow(/unknown/u)
  })

  it('rolls back registry changes when a plugin fails', () => {
    const registry = createPluginRegistry()
    registry.addFunction('existing', () => 1)

    expect(() => {
      registry.use((target) => {
        target.addFunction('partial', () => 2)
        target.addFunction('existing', () => 3)
      })
    }).toThrow(/already registered/u)
    expect(registry.getFunctionNames()).toEqual(['existing'])
    expect(registry.getFunction('partial')).toBeUndefined()
  })
})
