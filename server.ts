import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import cors from 'cors';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json()); // 允許後端接收 JSON 格式的 API 請求

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// ==========================================
// 💾 MongoDB 資料庫模型 (Schemas)
// ==========================================
const MONGO_URI = process.env.MONGODB_URI || '';

// 1. 管理員帳號模型
const adminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true } // 簡單密碼驗證
});
const Admin = mongoose.model('Admin', adminSchema);

// 2. 題庫包模型 (一個帳號可以有多個題庫包)
const quizPackSchema = new mongoose.Schema({
  title: { type: String, required: true }, // 例如："公會週末挑戰賽"
  author: { type: String, required: true }, // 建立者的 username
  questions: { type: Array, default: [] }   // 包含該題庫的所有題目
});
const QuizPack = mongoose.model('QuizPack', quizPackSchema);

if (MONGO_URI) {
  mongoose.connect(MONGO_URI).then(() => console.log('✅ MongoDB SaaS 版連線成功！')).catch(err => console.error('❌ MongoDB 連線失敗:', err));
}

// ==========================================
// 🌐 RESTful API 路由 (給另一個後台網頁用的)
// ==========================================

// API: 管理員註冊 (你可以自己用 API 工具打，或之後做個超級管理員介面)
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

// API: 管理員登入
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await Admin.findOne({ username, password });
    if (!user) return res.status(401).json({ error: '帳號或密碼錯誤' });
    res.json({ message: '登入成功', username: user.username });
  } catch (error) { res.status(500).json({ error: '伺服器錯誤' }); }
});

// API: 取得某人的所有題庫包
app.get('/api/quizzes/:username', async (req, res) => {
  try {
    const quizzes = await QuizPack.find({ author: req.params.username });
    res.json(quizzes);
  } catch (error) { res.status(500).json({ error: '讀取失敗' }); }
});

// API: 儲存/更新題庫包
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

// ==========================================
// 🎮 遊戲核心邏輯 (Socket.IO)
// ==========================================
const roomsData: Record<string, any> = {};

// 生成 6 位數隨機房號
function generatePIN() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

io.on('connection', (socket: Socket) => {

  // 👇 關鍵升級：主持人選擇題庫後，生成專屬房間與連結 👇
  socket.on('host_create_room', async (quizPackId) => {
    try {
      const quiz = await QuizPack.findById(quizPackId);
      if (!quiz) return socket.emit('error', '找不到該題庫');

      const pin = generatePIN();
      roomsData[pin] = { 
        hostSocketId: socket.id, // 綁定主持人身份
        quizData: quiz,          // 載入該題庫
        players: {}, 
        startTime: 0, 
        currentQuestion: null, 
        stats: {}, 
        currentQuestionIndex: 0 
      };

      socket.join(pin);
      // 回傳房號與加入連結給主持人
      socket.emit('room_created', { pin, joinUrl: `/?pin=${pin}` });
    } catch (err) {
      console.error(err);
    }
  });

  // 玩家加入房間
  socket.on('join_room', ({ pin, username }) => {
    const roomPin = String(pin).trim();
    const room = roomsData[roomPin];
    
    if (!room) return socket.emit('join_error', '房號不存在或遊戲已結束');
    if (room.currentQuestionIndex > 0) return socket.emit('join_error', '遊戲已經開始，無法加入');

    socket.join(roomPin);
    room.players[socket.id] = { username, score: 0, hasAnswered: false };
    
    // 通知所有人更新名單
    const currentPlayers = Object.values(room.players).map((p: any) => ({ username: p.username, score: p.score }));
    io.to(roomPin).emit('update_players', currentPlayers);
  });

  // 主持人發送題目
  socket.on('host_send_question', (pin: string) => {
    const room = roomsData[String(pin).trim()];
    if (!room || room.hostSocketId !== socket.id) return; // 只有該房的主持人能操作

    const qIndex = room.currentQuestionIndex || 0;
    const questions = room.quizData.questions;

    if (qIndex < questions.length) {
      const questionData = questions[qIndex]; 
      room.currentQuestion = questionData; 
      room.startTime = Date.now(); 
      room.stats = { 'A': 0, 'B': 0, 'C': 0, 'D': 0 }; 
      
      for (let id in room.players) room.players[id].hasAnswered = false;
      room.currentQuestionIndex = qIndex + 1;

      const { correctAnswer, correctMatches, ...clientQuestionData } = questionData;
      io.to(String(pin).trim()).emit('receive_question', { 
        ...clientQuestionData, 
        currentQIndex: room.currentQuestionIndex, 
        totalQuestions: questions.length 
      });
    }
  });

  socket.on('submit_answer', ({ pin, answerData }) => {
    const room = roomsData[String(pin).trim()];
    const player = room?.players[socket.id];

    if (room && player && !player.hasAnswered) {
      player.hasAnswered = true;
      const timeElapsed = (Date.now() - room.startTime) / 1000; 
      const tMax = room.currentQuestion.timeLimit;
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
    }
  });

  socket.on('host_show_leaderboard', (pin: string) => {
    const room = roomsData[String(pin).trim()];
    if (room && room.hostSocketId === socket.id) {
      const top5 = Object.values(room.players).sort((a:any, b:any) => b.score - a.score).slice(0, 5);
      io.to(String(pin).trim()).emit('leaderboard_updated', top5);
      const allPlayers = Object.values(room.players).map((p: any) => ({ username: p.username, score: p.score }));
      io.to(String(pin).trim()).emit('update_players', allPlayers);
    }
  });

  socket.on('host_show_review', (pin: string) => {
    const room = roomsData[String(pin).trim()];
    if (room && room.hostSocketId === socket.id) {
      io.to(String(pin).trim()).emit('review_updated', { 
        question: room.currentQuestion, 
        stats: room.stats, 
        hasNextQuestion: room.currentQuestionIndex < room.quizData.questions.length 
      });
    }
  });

  socket.on('host_show_podium', (pin: string) => {
    const room = roomsData[String(pin).trim()];
    if (room && room.hostSocketId === socket.id) {
      const top3 = Object.values(room.players).sort((a:any, b:any) => b.score - a.score).slice(0, 3);
      io.to(String(pin).trim()).emit('podium_updated', top3);
    }
  });

  socket.on('disconnect', () => {
    // 簡單清理邏輯 (實務上可以做更嚴謹的房主斷線處理)
    console.log(`❌ 裝置斷線 (ID: ${socket.id})`);
  });
});

server.listen(process.env.PORT || 3001, () => console.log('🚀 企業級伺服器啟動'));