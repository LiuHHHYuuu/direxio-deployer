import { CreateAgent, Tool} from "langchain/agents";
import { ChatDeepSeek } from "langchain/chat_models/deepseek";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { JsonOutputToolsParser } from "langchain/output_parsers";
import { InMemoryCheckpointer } from "langchain/checkpoint/in_memory";

const model = new ChatDeepSeek({ model: "deepseek-v4-pro", temperature: 0 });

const agent = CreateAgent({
    model,
    tools,
    prompt: "You are a helpful assistant that can help with tasks and questions.",
    outputParser: new JsonOutputToolsParser(),
    verbose: true,
})

const response = await agent.invoke({
    input: "I love bananas.How many contacts do I have in my database?"
    config: {
        thread_id: "123",
    }
});

console.log(response);

const checkpointer = new InMemoryCheckpointer();

const agentWithCheckpointer = CreateAgent({
    model,
    tools,
    prompt: "You are a helpful assistant that can help with tasks and questions.",
    outputParser: new JsonOutputToolsParser(),
    verbose: true,
    checkpointer,
})

type Role = { "assistant" | "user" | "tool" }
type Message = { 
    role: Role; 
    content: string 
    tool_name?: string
}


