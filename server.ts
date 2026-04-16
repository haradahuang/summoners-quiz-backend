import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const server = http.createServer(app);

app.get('/', (req, res) => { res.send('✅ 天空之島伺服器 (已連接資料庫) 正常運作中！'); });

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// ==========================================
// 💾 資料庫設定區塊
// ==========================================

// 從 Render 的保險箱讀取金鑰
const MONGO_URI = process.env.MONGODB_URI || '';

// 定義題目的資料格式
const questionSchema = new mongoose.Schema({
  id: Number, type: String, text: String, timeLimit: Number,
  correctAnswer: String, options: mongoose.Schema.Types.Mixed,
  topItems: mongoose.Schema.Types.Mixed, bottomItems: mongoose.Schema.Types.Mixed,
  correctMatches: mongoose.Schema.Types.Mixed
}, { strict: false });

const Question = mongoose.model('Question', questionSchema);

let questionBank: any[] = [];

// 啟動時連線到 MongoDB，並讀取題庫
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(async () => {
      console.log('✅ MongoDB 雲端資料庫連線成功！');
      const questions = await Question.find({}, { _id: 0, __v: 0 });
      
      if (questions.length === 0) {
        console.log('⚠️ 資料庫是空的，正在植入預設題目...');
        const defaultQuestions = [
          {
            id: 1, type: 'choice', text: "在《魔靈召喚》中，哪一個符文套裝的效果是「增加 25% 攻擊速度」？", correctAnswer: 'B', 
            options: [ { id: 'A', text: "暴走 (Violent)", color: '#e53e3e' }, { id: 'B', text: "迅捷 (Swift)", color: '#3182ce' }, { id: 'C', text: "絕望 (Despair)", color: '#d69e2e' }, { id: 'D', text: "激怒 (Rage)", color: '#805ad5' } ],
            timeLimit: 15 
          },
          {
            id: 2, type: 'match', text: "【魔靈觀察局】請將上方的魔靈與下方正確的「專屬美腿」配對！",
            topItems: [ { id: 'T1', name: '夢喵', img: 'https://i.postimg.cc/pmsHv9pt/m4.png' }, { id: 'T2', name: '暗奧', img: 'https://i.postimg.cc/DSxThW82/m3.png' }, { id: 'T3', name: '光瓦', img: 'https://i.postimg.cc/dhsYgRtJ/m1.png' }, { id: 'T4', name: '殺手', img: 'https://i.postimg.cc/Wd5vVDhV/m2.png' } ],
            bottomItems: [ { id: 'B1', img: 'https://i.postimg.cc/ZBGmQ10f/leg1.jpg' }, { id: 'B2', img: 'https://i.postimg.cc/jwpT1GC9/leg2.jpg' }, { id: 'B3', img: 'https://i.postimg.cc/0MTv4LrB/leg3.jpg' }, { id: 'B4', img: 'https://i.postimg.cc/7GF4RpbR/leg4.jpg' } ],
            correctMatches: { 'T1': 'B1', 'T2': 'B2', 'T3': 'B3', 'T4': 'B4' }, timeLimit: 30 
          }
        ];
        await Question.insertMany(defaultQuestions);
        questionBank = defaultQuestions;
      } else {
        questionBank = questions;
        console.log(`📚 成功載入 ${questionBank.length} 題題庫！`);
      }
    })
    .catch(err => console.error('❌ MongoDB 連線失敗:', err));
} else {
  console.log('⚠️ 未設定 MONGODB_URI 環境變數，資料庫功能停用。');
}

// ==========================================
// 🎮 遊戲核心邏輯
// ==========================================

const roomsData: Record<string, any> = {};
const ADMIN_PASSWORD = 'admin'; 

io.on('connection', (socket: Socket) => {
  socket.on('admin_login', (password) => { if (password === ADMIN_PASSWORD) socket.emit('admin_auth_success', questionBank); else socket.emit('admin_auth_fail'); });
  
  socket.on('admin_add_q', async (newQ) => { 
    newQ.id = Date.now(); 
    questionBank.push(newQ); 
    io.emit('admin_update_bank', questionBank); 
    // 👇 同步儲存到雲端 👇
    if(MONGO_URI) { try { await new Question(newQ).save(); } catch(e){ console.log("儲存失敗", e) } }
  });

  socket.on('admin_del_q', async (id) => { 
    questionBank = questionBank.filter(q => q.id !== id); 
    io.emit('admin_update_bank', questionBank); 
    // 👇 同步從雲端刪除 👇
    if(MONGO_URI) { try { await Question.deleteOne({ id: id }); } catch(e){ console.log("刪除失敗", e) } }
  });

  socket.on('join_room', ({ pin, username, isHost }) => {
    const roomPin = String(pin).trim();
    socket.join(roomPin);
    if (!roomsData[roomPin]) { roomsData[roomPin] = { players: {}, startTime: 0, currentQuestion: null, stats: {}, currentQuestionIndex: 0 }; } 
    else if (isHost) {
      roomsData[roomPin].currentQuestionIndex = 0; roomsData[roomPin].currentQuestion = null;
      for (let id in roomsData[roomPin].players) { roomsData[roomPin].players[id].score = 0; roomsData[roomPin].players[id].hasAnswered = false; }
    }
    if (!isHost) roomsData[roomPin].players[socket.id] = { username, score: 0, hasAnswered: false };
    
    const currentPlayers = Object.values(roomsData[roomPin].players).map((p: any) => ({ username: p.username, score: p.score }));
    io.to(roomPin).emit('update_players', currentPlayers);
  });

  socket.on('host_send_question', (pin: string) => {
    const roomPin = String(pin).trim(); const room = roomsData[roomPin]; if (!room) return;
    const qIndex = room.currentQuestionIndex || 0;
    if (qIndex < questionBank.length) {
      const questionData = questionBank[qIndex]; room.currentQuestion = questionData; room.startTime = Date.now(); room.stats = { 'A': 0, 'B': 0, 'C': 0, 'D': 0 }; 
      for (let id in room.players) room.players[id].hasAnswered = false;
      room.currentQuestionIndex = qIndex + 1;
      const { correctAnswer, correctMatches, ...clientQuestionData } = questionData;
      io.to(roomPin).emit('receive_question', { ...clientQuestionData, currentQIndex: room.currentQuestionIndex, totalQuestions: questionBank.length });
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
    }
  });

  socket.on('host_show_leaderboard', (pin: string) => {
    const roomPin = String(pin).trim();
    if (roomsData[roomPin]) {
      const top5 = Object.values(roomsData[roomPin].players).sort((a:any, b:any) => b.score - a.score).slice(0, 5);
      io.to(roomPin).emit('leaderboard_updated', top5);
      const allPlayers = Object.values(roomsData[roomPin].players).map((p: any) => ({ username: p.username, score: p.score }));
      io.to(roomPin).emit('update_players', allPlayers);
    }
  });

  socket.on('host_show_review', (pin: string) => {
    const roomPin = String(pin).trim();
    if (roomsData[roomPin]) io.to(roomPin).emit('review_updated', { question: roomsData[roomPin].currentQuestion, stats: roomsData[roomPin].stats, hasNextQuestion: roomsData[roomPin].currentQuestionIndex < questionBank.length });
  });

  socket.on('host_show_podium', (pin: string) => {
    const roomPin = String(pin).trim();
    if (roomsData[roomPin]) {
      const top3 = Object.values(roomsData[roomPin].players).sort((a:any, b:any) => b.score - a.score).slice(0, 3);
      io.to(roomPin).emit('podium_updated', top3);
    }
  });

  socket.on('disconnect', () => console.log(`❌ 裝置斷線 (ID: ${socket.id})`));
});

server.listen(process.env.PORT || 3001, () => console.log('🚀 伺服器啟動'));