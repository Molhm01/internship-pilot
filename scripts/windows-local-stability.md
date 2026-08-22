# Windows local stability

Local development uses Next's Webpack dev server on Windows, defaults ATS scoring to one Ollama generation at a time, and allows the supervisor to restart a crashed web process without discarding durable Postgres queue state.
