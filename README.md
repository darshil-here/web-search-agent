# web-search-agent

A TypeScript CLI chat agent that answers questions using a single web search tool.

## Run

```sh
npm install
cp .env.example .env
# fill in the values in .env
npm run dev
```

## Required environment variables

- `OPENAI_API_KEY` — API key used by the model client.
- `TAVILY_API_KEY` — API key used by the web search tool.
- `MODEL` — model identifier to run.

## Traces

Each run writes a trace file under `traces/`.
