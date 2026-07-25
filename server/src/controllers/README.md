# controllers/

Thin request handlers backing `routes/`. A controller: reads validated input from `req` (validation already happened in `middleware/` or `validators/` — a controller does not itself contain validation logic), calls one or more `services/` or `repositories/` methods, and shapes the HTTP response. No SQL. No cross-cutting business rules that belong in `services/` instead — a controller orchestrates, it doesn't decide.

Kept separate from `routes/` so route *wiring* (which path maps to which handler, which middleware applies) can be reviewed independently from route *handling* (what the handler actually does).
