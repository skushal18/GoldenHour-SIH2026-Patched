const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const { getIncomingCases, updateCapacity } = require('../controllers/hospitalController');

router.use(authenticateToken);

router.get('/:id/incoming', getIncomingCases);
router.put('/:id/capacity', updateCapacity);

module.exports = router;
