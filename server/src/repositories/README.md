# repositories/

MariaDB access only. One repository per aggregate (e.g. `tenantRepository`, `userRepository`, `licenseRepository`, `sessionRepository`) — a repository method takes and returns plain data, never an HTTP request/response object, and never encodes a business rule (it doesn't decide *whether* a tenant is allowed to do something; a `services/` caller decides that, then asks the repository to read or write the result).

Every query in this project's real backend today lives inline in `server/local.js`'s route handlers via raw `better-sqlite3` calls — this layer is where that access gets isolated and made independently testable, starting Phase 2.
