import { expect, test } from 'bun:test'
import { z } from 'zod/v4'
import {
  getEmptyToolPermissionContext,
  TOOL_NAME_PREFIX_RECOVERY_ALLOWED,
  type Tool,
  type Tools,
} from '../Tool.js'
import { SkillTool } from '../tools/SkillTool/SkillTool.js'
import { toolToAPISchema } from './api.js'

test('toolToAPISchema preserves provider-specific schema keywords in input_schema', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'WebFetch',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            format: 'uri',
            description: 'Public HTTP or HTTPS URL',
          },
          metadata: {
            type: 'object',
            propertyNames: {
              pattern: '^[a-z]+$',
            },
            properties: {
              callback: {
                type: 'string',
                format: 'uri-reference',
              },
            },
          },
        },
      },
      prompt: async () => 'Fetch a URL',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  expect(schema).toMatchObject({
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          format: 'uri',
          description: 'Public HTTP or HTTPS URL',
        },
        metadata: {
          type: 'object',
          propertyNames: {
            pattern: '^[a-z]+$',
          },
          properties: {
            callback: {
              type: 'string',
              format: 'uri-reference',
            },
          },
        },
      },
    },
  })
})

test('toolToAPISchema keeps skill required for SkillTool', async () => {
  const schema = await toolToAPISchema(SkillTool, {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [] as unknown as Tools,
    agents: [],
  })

  expect((schema as { input_schema: unknown }).input_schema).toMatchObject({
    type: 'object',
    required: ['skill'],
  })
})

test('toolToAPISchema permits prefix recovery only for internal tools', async () => {
  const options = {
    getToolPermissionContext: async () => getEmptyToolPermissionContext(),
    tools: [] as unknown as Tools,
    agents: [],
  }
  const makeTool = (name: string, extras: Partial<Tool> = {}) =>
    ({
      name,
      inputSchema: z.strictObject({}),
      prompt: async () => name,
      ...extras,
    }) as unknown as Tool

  const internalSchema = await toolToAPISchema(makeTool('Read'), options)
  const prefixedMcpSchema = await toolToAPISchema(
    makeTool('mcp__files__read'),
    options,
  )
  const unprefixedMcpSchema = await toolToAPISchema(
    makeTool('send', {
      isMcp: true,
      mcpInfo: { serverName: 'mail', toolName: 'send' },
    } as Partial<Tool>),
    options,
  )

  expect(
    (internalSchema as unknown as Record<PropertyKey, unknown>)[
      TOOL_NAME_PREFIX_RECOVERY_ALLOWED
    ],
  ).toBe(true)
  expect(
    (prefixedMcpSchema as unknown as Record<PropertyKey, unknown>)[
      TOOL_NAME_PREFIX_RECOVERY_ALLOWED
    ],
  ).toBe(false)
  expect(
    (unprefixedMcpSchema as unknown as Record<PropertyKey, unknown>)[
      TOOL_NAME_PREFIX_RECOVERY_ALLOWED
    ],
  ).toBe(false)
  expect(JSON.stringify(internalSchema)).not.toContain(
    'verboo.tool-name-prefix-recovery-allowed',
  )
})

test('toolToAPISchema removes extra required keys not in properties (MCP schema sanitization)', async () => {
  const schema = await toolToAPISchema(
    {
      name: 'mcp__test__create_object',
      inputSchema: z.strictObject({}),
      inputJSONSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name', 'attributes'],
      },
      prompt: async () => 'Create an object',
    } as unknown as Tool,
    {
      getToolPermissionContext: async () => getEmptyToolPermissionContext(),
      tools: [] as unknown as Tools,
      agents: [],
    },
  )

  const inputSchema = (schema as { input_schema: { required?: string[] } }).input_schema
  expect(inputSchema.required).toEqual(['name'])
})
