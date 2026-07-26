'use strict';

const alertService = require('../services/alertService');

async function list(req, res, next) {
  try { res.json(await alertService.listAlerts({ includeDismissed: req.query.includeDismissed === 'true' })); }
  catch (e) { next(e); }
}
function markRead(req, res, next) { try { res.json(alertService.markRead(req.params.key)); } catch (e) { next(e); } }
function markDismissed(req, res, next) { try { res.json(alertService.markDismissed(req.params.key)); } catch (e) { next(e); } }

module.exports = { list, markRead, markDismissed };
