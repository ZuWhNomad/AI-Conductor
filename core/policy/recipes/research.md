---
id: research
types: [research, search, summarize, read]
audience: conductor
purpose: Checkable research from accessible, cited sources
status: draft
---
Default method, not a rule set.

1. Restate the question so that an answer can be checked. If you cannot, ask once: what decision is this for,
   what form should the answer take, which sources are trusted.
2. Look for an existing route before searching the web: a dataset, an API or MCP server, a local program, earlier notes.
3. If a source needs special access (a social-media link, a video), use a model that has it; never guess at content you cannot open.
4. Split by source or sub-question. One sub-agent per piece, same output schema, in parallel. You read only their results.
5. Documents: chunk by structure, not size (outline → headings → fixed size at paragraph boundaries). Split with a
   script, not a model. One sub-agent per chapter. Record source + page range + method; spot-check one chunk per method first.
6. Every claim carries its source and the quoted phrase or number. Mark unsourced claims as unsourced.
7. Before reporting: check that each citation resolves and contains the quote (script, not model); report
   disagreements between sources as disagreements; state what was not verified.
8. Stop at the agreed source or time budget. As a default, aim for two independent sources per fact when useful.

Questions worth asking (only ones that change the plan):
- What decision does this feed, and by when?
- What does the user already believe, so it is tested rather than repeated?
- What would change their mind?
