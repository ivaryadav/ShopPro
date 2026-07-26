'use strict';

const jobRunnerService = require('../services/jobRunnerService');
const auditService = require('../services/auditService');
const { NotFoundError } = require('../errors');

async function list(req, res, next) {
  try {
    const jobs = jobRunnerService.listStatuses().map((s) => ({ ...s, history: jobRunnerService.getHistory(s.name, 10) }));
    res.json({ jobs });
  } catch (e) { next(e); }
}
async function runNow(req, res, next) {
  try {
    const status = await jobRunnerService.runNow(req.params.name);
    auditService.record({ platformUserId: req.platformUser.userId, action: 'JOB_MANUALLY_TRIGGERED', detail: req.params.name, ip: req.ip });
    res.json({ job: status });
  } catch (e) {
    if (/is not registered/.test(e.message)) return next(new NotFoundError(`Job "${req.params.name}" not found`));
    next(e);
  }
}

module.exports = { list, runNow };
