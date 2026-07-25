# services/

Business logic — the license state machine, tenant-isolation rules, subscription lifecycle transitions, anything that decides *what should happen*, as opposed to *how to store it* (`repositories/`) or *how to expose it over HTTP* (`routes/`/`controllers/`).

Per ADR-0005, a service layer is added "only where justified" — a route that does nothing but validate and call one repository method doesn't need a service manufacturing indirection for its own sake. Add a service when there's real business logic to isolate and unit-test independent of both HTTP and the database.
