import { readFileSync } from 'node:fs'

const instructions = readFileSync(new URL('./inventory-add-entry.md', import.meta.url), 'utf8')
const string = { type: 'string' }
function tool(name, description, properties) {
  return {
    type: 'function', name, description, strict: true,
    parameters: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
  }
}

const tools = [
  tool('list_collections', 'List live inventory collections before choosing a destination.', {}),
  tool('inspect_collection', 'Get the latest record structure, validator, and known relationship types.', { collection: string }),
  tool('find_records', 'Find records by label, name, address, description or string ID. Returns numbered references and building context for units.', {
    collection: string, search: string,
  }),
  tool('propose_entry', 'Prepare an entry for the user to review. fields is a JSON object encoded as a string.', {
    collection: string,
    fields: string,
    links: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: { target: { type: 'integer' }, type: string, description: string },
        required: ['target', 'type', 'description'],
      },
    },
  }),
]

export function openAIInventory({ apiKey, model }) {
  return async function respond(messages, invoke) {
    const input = [...messages]
    const signal = AbortSignal.timeout(75_000)
    for (let turn = 0; turn < 10; turn++) {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, instructions, input, tools, store: false, include: ['reasoning.encrypted_content'],
          parallel_tool_calls: false, max_output_tokens: 2500, reasoning: { effort: 'low' },
        }),
      })
      if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`)
      const { status, output } = await response.json()
      if (status !== 'completed') throw new Error('Incomplete OpenAI response')
      const calls = output.filter(item => item.type === 'function_call')
      if (!calls.length) {
        const message = output.flatMap(item => item.content ?? [])
          .map(part => part.type === 'output_text' ? part.text : part.refusal ?? '').join('').trim()
        return message || 'Describe the inventory entry you would like to add.'
      }

      input.push(...output)
      for (const call of calls) {
        const result = await invoke(call.name, JSON.parse(call.arguments))
        if (result.draft) return null
        input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(result) })
      }
    }
    return 'Please narrow this to one inventory entry and include the building or unit if it applies.'
  }
}
