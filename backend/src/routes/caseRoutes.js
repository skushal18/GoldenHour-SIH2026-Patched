const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const {
  createCase, getCase, sendCase, acknowledgeCase,
  updateLocation, updateTeamReadiness, divertCase,
  arriveCase, closeCase, getCaseEvents, requestResources
} = require('../controllers/caseController');

router.use(authenticateToken); // all case routes need auth

router.post('/', createCase);
router.get('/:id', getCase);
router.post('/:id/send', sendCase);
router.post('/:id/acknowledge', acknowledgeCase);
router.post('/:id/location', updateLocation);
router.post('/:id/team-readiness', updateTeamReadiness);
router.post('/:id/divert', divertCase);
router.post('/:id/arrive', arriveCase);
router.post('/:id/close', closeCase);
router.get('/:id/events', getCaseEvents);
router.post('/:id/resources', requestResources);

module.exports = router;