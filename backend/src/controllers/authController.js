const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

const login = async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password required' });
  }

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email]);

    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const user = rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = jwt.sign(
      {
        user_id: user.user_id,
        email: user.email,
        role: user.role,
        hospital_id: user.hospital_id,
        ambulance_id: user.ambulance_id
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        token,
        user: {
          user_id: user.user_id,
          name: user.name,
          email: user.email,
          role: user.role
        }
      }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const register = async (req, res) => {
  const { name, email, password, role, hospital_id, ambulance_id } = req.body;

  try {
    const [existing] = await pool.query('SELECT user_id FROM users WHERE email = ?', [email]);
    if (existing.length > 0) {
      return res.status(400).json({ success: false, message: 'Email already registered' });
    }

    const salt = await bcrypt.genSalt(10);
    const password_hash = await bcrypt.hash(password, salt);

    const [result] = await pool.query(
      'INSERT INTO users (name, email, password_hash, role, hospital_id, ambulance_id) VALUES (?, ?, ?, ?, ?, ?)',
      [name, email, password_hash, role, hospital_id || null, ambulance_id || null]
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      data: { user_id: result.insertId, name, email, role }
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { login, register };