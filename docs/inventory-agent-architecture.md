# Property Inventory agent on the Raspberry Pi

Proposed insertion flow. The user calls the inventory agent on the Pi. Ollama runs the local model, and the agent uses MongoDB MCP to look up live inventory, save records, and verify the result.

```mermaid
sequenceDiagram
    actor User
    participant Agent as Inventory Agent on the Pi<br/>(local model via Ollama)
    participant MCP as MongoDB MCP Server
    participant DB as MongoDB Atlas

    User->>Agent: Add a microwave to unit 3L

    loop As needed
        Agent->>MCP: Look up units, collections, and existing records
        MCP->>DB: Query live inventory
        DB-->>MCP: Return results
        MCP-->>Agent: Return lookup results
    end

    alt The target and required details are clear
        Note over Agent: Choose the collection, fields, and relationships
        Agent->>MCP: Save the appliance and its relationships
        MCP->>DB: Execute writes
        DB-->>MCP: Return write results
        MCP-->>Agent: Return saved IDs or an error
        opt Writes succeeded
            Agent->>MCP: Read back the saved records by ID
            MCP->>DB: Fetch saved records
            DB-->>MCP: Return saved records
            MCP-->>Agent: Return records for verification
        end
        Agent-->>User: Confirm the verified save or report the issue
    else The target or required details are ambiguous
        Agent-->>User: Which building contains unit 3L?
    end
```
