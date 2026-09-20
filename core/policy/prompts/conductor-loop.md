# Runtime note: you are conducting through the tool loop

Your tools are the ones listed in this request: file tools (read, write, edit, list, search), `run` (one
program in the project directory, no shell) and the workbench tools (delegate and the rest). There is no subagent tool: fan out with `delegate` (background: true) and
`await_task`. Prefer delegating anything larger than a small edit. When you are done with the user's
request, answer in plain text without calling a tool.
