const express = require('express');
const { Pool } = require('pg');
const { MongoClient, ServerApiVersion } = require('mongodb');
const bcrypt = require('bcrypt');
const cors = require('cors');
const jwt = require('jsonwebtoken');

// ---- //
const nodemailer = require('nodemailer');
// ---- // 

const app = express();

require("dotenv").config();


app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.POSTGRES_URI,
});

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, { serverApi: ServerApiVersion.v1 });

let database;

async function connectToMongoDB() {
  try {
    await client.connect();
    database = client.db("myDatabase");
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("Failed to connect to MongoDB", error);
  }
}

connectToMongoDB();

async function createUser(email, password, points = 0) {
  const users = database.collection("users");
  const hashedPassword = await bcrypt.hash(password, 10);
  const user = { email, password: hashedPassword, points, wrongList: {}, correctList: [] };
  const result = await users.insertOne(user);
  console.log(`New user created with ID: ${result.insertedId}`);
  return result.insertedId;
}

async function findUserByEmail(email) {
  const users = database.collection("users");
  return await users.findOne({ email });
}

async function updateUserPoints(email, points, word, isCorrect) {
  const users = database.collection("users");
  const user = await users.findOne({ email });
  
  if (user) {
    let newPoints = user.points + points;
    if (newPoints < 0) newPoints = 0;

    if (isCorrect) {
      user.correctList = updateCorrectList(user.correctList, word);
      if (user.wrongList[word]) delete user.wrongList[word];
    } else {
      user.wrongList = updateWrongList(user.wrongList, word);
    }

    await users.updateOne(
      { email },
      { $set: { points: newPoints, wrongList: user.wrongList, correctList: user.correctList } }
    );
    
    return newPoints;
  }
  return null;
}

function updateCorrectList(correctList, word) {
  if (correctList.includes(word)) {
    return correctList;
  }

  const wordEntry = correctList.find(entry => entry.word === word);
  if (wordEntry) {
    wordEntry.count++;
    if (wordEntry.count === 3) {
      correctList = correctList.filter(entry => entry.word !== word);
      correctList.push(word);
    }
  } else {
    correctList.push({ word, count: 1 });
  }

  return correctList;
}

function updateWrongList(wrongList, word) {
  wrongList[word] = (wrongList[word] || 0) + 1;
  return wrongList;
}

app.post('/correctWords', async (req, res) => {
  const { email } = req.body;

  try {
    const user = await findUserByEmail(email);
    if (user) {
      res.status(200).send({ correctList: user.correctList });
    } else {
      res.status(404).send('User not found');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/register', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).send('Email and password are required');
  }

  try {
    const existingUser = await findUserByEmail(email);
    if (existingUser) {
      return res.status(409).send('User already exists');
    }

    const userId = await createUser(email, password);
    res.status(201).send({ message: 'User created successfully', userId });
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).send('Email and password are required');
  }

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).send('Invalid credentials');
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).send('Invalid credentials');
    }

    const token = jwt.sign({ userId: user._id, email: user.email }, 'your_jwt_secret', { expiresIn: '1h' });

    res.status(200).send({ message: 'Login successful', token, points: user.points });
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/correct', async (req, res) => {
  const { email, word } = req.body;

  try {
    const newPoints = await updateUserPoints(email, 5, word, true);
    if (newPoints !== null) {
      res.status(200).send({ message: 'Points updated successfully', points: newPoints });
    } else {
      res.status(404).send('User not found');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.post('/incorrect', async (req, res) => {
  const { email, word } = req.body;

  try {
    const newPoints = await updateUserPoints(email, -2, word, false);
    if (newPoints !== null) {
      res.status(200).send({ message: 'Points updated successfully', points: newPoints });
    } else {
      res.status(404).send('User not found');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/quiz', async (req, res) => {
  try {
    const result = await pool.query(`
      WITH random_question AS (
        SELECT root AS question, definition AS correct_answer
        FROM latin_roots
        OFFSET floor(random() * (SELECT COUNT(*) FROM latin_roots)) LIMIT 1
      ),
      wrong_answers AS (
        SELECT wrong_answer
        FROM (
          SELECT DISTINCT definition AS wrong_answer
          FROM latin_roots
          WHERE definition <> (SELECT correct_answer FROM random_question)
        ) AS subquery
        ORDER BY random()
        LIMIT 3
      )
      SELECT question, correct_answer, array_agg(wrong_answer) AS wrong_answers
      FROM random_question, wrong_answers
      GROUP BY question, correct_answer;
    `);

    if (result.rows.length === 0) {
      throw new Error('No quiz question found');
    }

    const quiz = result.rows[0];
    const allAnswers = [quiz.correct_answer, ...quiz.wrong_answers];

    const uniqueAnswers = [...new Set(allAnswers)];

    while (uniqueAnswers.length < 4) {
      const additionalAnswers = await pool.query(`
        SELECT DISTINCT definition AS wrong_answer
        FROM latin_roots
        WHERE definition <> $1
        AND definition NOT IN (${uniqueAnswers.map((_, i) => `$${i + 2}`).join(', ')})
        ORDER BY random()
        LIMIT ${4 - uniqueAnswers.length};
      `, [quiz.correct_answer, ...uniqueAnswers]);

      uniqueAnswers.push(...additionalAnswers.rows.map(row => row.wrong_answer));
    }

    res.json({
      question: quiz.question,
      correct_answer: quiz.correct_answer,
      answers: uniqueAnswers.sort(() => Math.random() - 0.5),
    });
  } catch (err) {
    console.error('Error executing query', err.stack);
    res.status(500).send(`Error retrieving data: ${err.message}`);
  }
});

app.get('/correctWords', async (req, res) => {
  const { email } = req.query;

  try {
    const user = await findUserByEmail(email);
    if (user) {
      res.status(200).send({ correctList: user.correctList });
    } else {
      res.status(404).send('User not found');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/wrongWords', async (req, res) => {
  const { email } = req.query;

  try {
    const user = await findUserByEmail(email);
    if (user) {
      res.status(200).send({ wrongList: user.wrongList });
    } else {
      res.status(404).send('User not found');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/points', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).send('Email is required');
  }

  try {
    const user = await findUserByEmail(email);
    if (user) {
      res.status(200).send({ points: user.points });
    } else {
      res.status(404).send('User not found');
    }
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/hello', (req, res) => {
  res.send('Hello World!');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

// ---- //

function authorizeRole(role) {
    return (req, res, next) => {
      const token = req.headers.authorization?.split(" ")[1];
      if (!token) return res.status(401).send("Access denied");
  
      try {
        const decoded = jwt.verify(token, 'your_jwt_secret');
        if (decoded.role !== role) {
          return res.status(403).send("Forbidden");
        }
        next();
      } catch (err) {
        res.status(401).send("Invalid token");
      }
    };
  }

app.post('/admin-only', authorizeRole('admin'), (req, res) => {
res.send('Admin route');
});

app.post('/forgot-password', async (req, res) => {
const { email } = req.body;
try {
    const user = await findUserByEmail(email);
    if (!user) return res.status(404).send("User not found");

    const resetToken = jwt.sign({ email }, 'reset_secret', { expiresIn: '15m' });
    res.status(200).send({ message: 'Password reset email sent' });
} catch (err) {
    res.status(500).send('Internal Server Error');
}
});

quizResults: [
{
    question: String,
    correct: Boolean,
    timestamp: Date
}
]

app.post('/submitQuiz', async (req, res) => {
    const { email, question, correct } = req.body;
    try {
      const users = database.collection("users");
      const timestamp = new Date();
      await users.updateOne(
        { email },
        { $push: { quizResults: { question, correct, timestamp } } }
      );
      res.status(200).send('Quiz result saved');
    } catch (err) {
      res.status(500).send('Internal Server Error');
    }
  });
  
app.get('/quizHistory', async (req, res) => {
const { email } = req.query;
try {
    const user = await findUserByEmail(email);
    if (user) {
    res.status(200).send(user.quizResults);
    } else {
    res.status(404).send('User not found');
    }
} catch (err) {
    res.status(500).send('Internal Server Error');
}
});

app.get('/leaderboard', async (req, res) => {
try {
    const users = database.collection("users");
    const topUsers = await users
    .find()
    .sort({ points: -1 })
    .limit(10)
    .project({ email: 1, points: 1 })
    .toArray();
    res.status(200).send(topUsers);
} catch (err) {
    res.status(500).send('Internal Server Error');
}
});

app.post('/addQuizQuestion', authorizeRole('admin'), async (req, res) => {
    const { question, correctAnswer, wrongAnswers } = req.body;
    try {
      const result = await pool.query(
        `INSERT INTO latin_roots (root, definition)
         VALUES ($1, $2)
         RETURNING id;`,
        [question, correctAnswer]
      );
      res.status(201).send({ message: 'Question added successfully', id: result.rows[0].id });
    } catch (err) {
      res.status(500).send('Internal Server Error');
    }
  });

app.delete('/deleteAccount', async (req, res) => {
const { email, password } = req.body;
try {
    const user = await findUserByEmail(email);
    if (!user) return res.status(404).send('User not found');

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) return res.status(401).send('Invalid credentials');

    await database.collection("users").deleteOne({ email });
    res.status(200).send('Account deleted successfully');
} catch (err) {
    res.status(500).send('Internal Server Error');
}
});

async function assignBadge(email, badge) {
    const users = database.collection("users");
    const user = await users.findOne({ email });
    if (user && !user.badges.includes(badge)) {
      await users.updateOne(
        { email },
        { $push: { badges: badge } }
      );
      return `Badge "${badge}" awarded!`;
    }
    return "Badge already assigned or user not found";
  }
  
app.post('/awardBadge', async (req, res) => {
const { email, badge } = req.body;
try {
    const message = await assignBadge(email, badge);
    res.status(200).send({ message });
} catch (err) {
    res.status(500).send('Internal Server Error');
}
});


const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

async function sendEmail(to, subject, text) {
  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text
    });
    console.log('Email sent');
  } catch (error) {
    console.error('Failed to send email:', error);
  }
}

app.post('/sendNotification', async (req, res) => {
  const { email, subject, message } = req.body;
  try {
    await sendEmail(email, subject, message);
    res.status(200).send('Notification email sent');
  } catch (err) {
    res.status(500).send('Internal Server Error');
  }
});

app.get('/analytics', async (req, res) => {
    const { email } = req.query;
    try {
      const user = await findUserByEmail(email);
      if (user) {
        const analytics = {
          totalQuizzes: user.quizResults.length,
          correctAnswers: user.quizResults.filter(result => result.correct).length,
          incorrectAnswers: user.quizResults.filter(result => !result.correct).length,
          streak: user.streak || 0,
        };
        res.status(200).send(analytics);
      } else {
        res.status(404).send('User not found');
      }
    } catch (err) {
      res.status(500).send('Internal Server Error');
    }
  });

app.get('/searchQuestions', async (req, res) => {
    const { keyword, difficulty, topic } = req.query;
    try {
      const query = {};
      if (keyword) query.root = { $regex: keyword, $options: 'i' };
      if (difficulty) query.difficulty = difficulty;
      if (topic) query.topic = topic;
  
      const questions = await pool.query(
        'SELECT * FROM latin_roots WHERE $1',
        [query]
      );
      res.status(200).send(questions.rows);
    } catch (err) {
      res.status(500).send('Internal Server Error');
    }
  });

const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });
  
wss.on('connection', (ws) => {
    console.log('User connected');
  
    ws.on('message', (message) => {
      console.log('Received:', message);
    });
  
    ws.on('close', () => {
      console.log('User disconnected');
    });
  });
  
function notifyLeaderboardUpdate() {
    const message = JSON.stringify({ event: 'leaderboardUpdate', data: 'Leaderboard updated!' });
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

app.post('/banUser', authorizeRole('admin'), async (req, res) => {
    const { email } = req.body;
  
    try {
      const users = database.collection("users");
      await users.updateOne({ email }, { $set: { banned: true } });
      res.status(200).send('User banned');
    } catch (err) {
      res.status(500).send('Internal Server Error');
    }
  });

// updated authentication //

const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: '/auth/google/callback',
}, async (accessToken, refreshToken, profile, done) => {
  try {
    let user = await findUserByEmail(profile.emails[0].value);
    if (!user) {
      user = await createUser(profile.emails[0].value, 'google-auth', 0);
    }
    done(null, user);
  } catch (err) {
    done(err);
  }
}));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));
app.get('/auth/google/callback', passport.authenticate('google', { session: false }), (req, res) => {
  res.send('Logged in with Google');
});

// ---- //