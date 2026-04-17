import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(cors());

// 👇 關鍵解鎖：將原本預設的 100kb 限制放寬到 50mb，讓 Base64 圖片資料可以順利進入大腦！ 👇
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const MONGO_URI = process.env.MONGODB_URI || '';

const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true }
});
const Admin = mongoose.model('Admin', adminSchema);

const quizPackSchema = new mongoose.Schema({
  title: { type: String, required: true },
  author: { type: String, required: true },
  questions: { type: Array, default: [] }
});
const QuizPack = mongoose.model('QuizPack', quizPackSchema);

if (MONGO_URI) {
  mongoose.connect(MONGO_URI).then(() => console.log('✅ MongoDB 連線成功！')).catch(err => console.error('❌ MongoDB 連線失敗:', err));
}

// ==========================================
// 🌐 API 路由
// ==========================================
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const existing = await Admin.findOne({ username });
    if (existing) return res.status(400).json({ error: '帳號已存在' });
    const newAdmin = new Admin({ username, password });
    await newAdmin.save();
    res.json({ message: '帳號建立成功！' });
  } catch (error) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await Admin.findOne({ username, password });
    if (!user) return res.status(401).json({ error: '帳號或密碼錯誤' });
    res.json({ message: '登入成功', username: user.username });
  } catch (error) { res.status(500).json({ error: '伺服器錯誤' }); }
});

app.get('/api/quizzes/:username', async (req, res) => {
  try {
    const quizzes = await QuizPack.find({ author: req.params.username });
    res.json(quizzes);
  } catch (error) { res.status(500).json({ error: '讀取失敗' }); }
});

app.post('/api/quizzes', async (req, res) => {
  try {
    const { id, title, author, questions } = req.body;
    if (id) {
      await QuizPack.findByIdAndUpdate(id, { title, questions });
      res.json({ message: '題庫更新成功' });
    } else {
      const newQuiz = new QuizPack({ title, author, questions });
      await newQuiz.save();
      res.json({ message: '題庫建立成功', quiz: newQuiz });
    }
  } catch (error) { res.status(500).json({ error: '儲存失敗' }); }
});

app.delete('/api/quizzes/:id', async (req, res) => {
  try {
    await QuizPack.findByIdAndDelete(req.params.id);
    res.json({ message: '刪除成功' });
  } catch (error) { res.status(500).json({ error: '刪除失敗' }); }
});


// ==========================================
// 🎮 遊戲核心邏輯 (Socket.IO)
// ==========================================
const roomsData: Record<string, any> = {};

function generatePIN() { return Math.floor(100000 + Math.random() * 900000).toString(); }

io.on('connection', (socket: Socket) => {

  socket.on('host_create_room', async (quizPackId) => {
    try {
      const quiz = await QuizPack.findById(quizPackId);
      if (!quiz) return socket.emit('error', '找不到該題庫');

      const pin = generatePIN();
      roomsData[pin] = { hostSocketId: socket.id, quizData: quiz, players: {}, startTime: 0, currentQuestion: null, stats: {}, currentQuestionIndex: 0 };
      socket.join(pin);
      socket.emit('room_created', { pin, joinUrl: `/?pin=${pin}` });
    } catch (err) { console.error(err); }
  });

  socket.on('join_room', ({ pin, username }) => {
    const roomPin = String(pin).trim(); const room = roomsData[roomPin];
    if (!room) return socket.emit('join_error', '房號不存在或遊戲已結束');
    if (room.currentQuestionIndex > 0) return socket.emit('join_error', '遊戲已經開始，無法加入');

    socket.join(roomPin);
    room.players[socket.id] = { username, score: 0, hasAnswered: false };
    
    const currentPlayers = Object.values(room.players).map((p: any) => ({ username: p.username, score: p.score, hasAnswered: p.hasAnswered }));
    io.to(roomPin).emit('update_players', currentPlayers);
  });

  socket.on('host_send_question', (pin: string) => {
    const roomPin = String(pin).trim(); const room = roomsData[roomPin];
    if (!room || room.hostSocketId !== socket.id) return;

    const qIndex = room.currentQuestionIndex || 0; const questions = room.quizData.questions;
    if (qIndex < questions.length) {
      const questionData = questions[qIndex]; room.currentQuestion = questionData; room.startTime = Date.now(); room.stats = { 'A': 0, 'B': 0, 'C': 0, 'D': 0 }; 
      for (let id in room.players) room.players[id].hasAnswered = false;
      room.currentQuestionIndex = qIndex + 1;

      const { correctAnswer, correctMatches, ...clientQuestionData } = questionData;
      io.to(roomPin).emit('receive_question', { ...clientQuestionData, currentQIndex: room.currentQuestionIndex, totalQuestions: questions.length });
      
      const currentPlayers = Object.values(room.players).map((p: any) => ({ username: p.username, score: p.score, hasAnswered: p.hasAnswered }));
      io.to(roomPin).emit('update_players', currentPlayers);
    }
  });

  socket.on('submit_answer', ({ pin, answerData }) => {
    const roomPin = String(pin).trim(); const room = roomsData[roomPin]; const player = room?.players[socket.id];
    if (room && player && !player.hasAnswered) {
      player.hasAnswered = true;
      const timeElapsed = (Date.now() - room.startTime) / 1000; const tMax = room.currentQuestion.timeLimit;
      let isCorrect = false;

      if (room.currentQuestion.type === 'match') {
        const correct = room.currentQuestion.correctMatches;
        isCorrect = Object.keys(correct).every(k => correct[k] === answerData[k]) && Object.keys(answerData).length === Object.keys(correct).length;
      } else {
        isCorrect = (answerData === room.currentQuestion.correctAnswer);
        if (room.stats[answerData] !== undefined) room.stats[answerData]++;
      }

      let earnedScore = 0;
      if (isCorrect) {
        earnedScore = Math.round(1000 * (1 - (timeElapsed / (2 * tMax))));
        if (earnedScore < 500) earnedScore = 500; if (earnedScore > 1000) earnedScore = 1000;
        player.score += earnedScore;
      }
      socket.emit('answer_result', { isCorrect, earnedScore, totalScore: player.score });
      
      const currentPlayers = Object.values(room.players).map((p: any) => ({ username: p.username, score: p.score, hasAnswered: p.hasAnswered }));
      io.to(roomPin).emit('update_players', currentPlayers);
    }
  });

  socket.on('host_show_leaderboard', (pin: string) => {
    const roomPin = String(pin).trim(); const room = roomsData[roomPin];
    if (room && room.hostSocketId === socket.id) {
      const top5 = Object.values(room.players).sort((a:any, b:any) => b.score - a.score).slice(0, 5);
      io.to(roomPin).emit('leaderboard_updated', top5);
      const allPlayers = Object.values(room.players).map((p: any) => ({ username: p.username, score: p.score, hasAnswered: p.hasAnswered }));
      io.to(roomPin).emit('update_players', allPlayers);
    }
  });

  socket.on('host_show_review', (pin: string) => {
    const roomPin = String(pin).trim(); const room = roomsData[roomPin];
    if (room && room.hostSocketId === socket.id) {
      io.to(roomPin).emit('review_updated', { question: room.currentQuestion, stats: room.stats, hasNextQuestion: room.currentQuestionIndex < room.quizData.questions.length });
    }
  });

  socket.on('host_show_podium', (pin: string) => {
    const roomPin = String(pin).trim(); const room = roomsData[roomPin];
    if (room && room.hostSocketId === socket.id) {
      const top3 = Object.values(room.players).sort((a:any, b:any) => b.score - a.score).slice(0, 3);
      io.to(roomPin).emit('podium_updated', top3);
    }
  });

  socket.on('disconnect', () => console.log(`❌ 裝置斷線 (ID: ${socket.id})`));
});

server.listen(process.env.PORT || 3001, () => console.log('🚀 企業級伺服器啟動'));