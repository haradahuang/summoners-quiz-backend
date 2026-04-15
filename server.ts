import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';

const app = express();
const server = http.createServer(app);

app.get('/', (req, res) => {
  res.send('✅ 天空之島伺服器正常運作中！(Server is running)');
});

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// 全域題庫
let questionBank: any[] = [
  {
    id: Date.now(),
    text: "在《魔靈召喚》中，哪一個符文套裝的效果是「增加 25% 攻擊速度」？",
    correctAnswer: 'B', 
    options: [
      { id: 'A', text: "暴走 (Violent)", color: '#e53e3e' },
      { id: 'B', text: "迅捷 (Swift)", color: '#3182ce' },
      { id: 'C', text: "絕望 (Despair)", color: '#d69e2e' },
      { id: 'D', text: "激怒 (Rage)", color: '#805ad5' }
    ],
    timeLimit: 10 
  }
];

const roomsData: Record<string, any> = {};
const ADMIN_PASSWORD = 'admin1234'; 

io.on('connection', (socket: Socket) => {
  console.log(`⚡ 系統提示: 裝置連線 (ID: ${socket.id})`);

  socket.on('admin_login', (password) => {
    if (password === ADMIN_PASSWORD) {
      socket.emit('admin_auth_success', questionBank);
    } else {
      socket.emit('admin_auth_fail');
    }
  });

  socket.on('admin_add_q', (newQ) => {
    newQ.id = Date.now(); 
    questionBank.push(newQ);
    io.emit('admin_update_bank', questionBank); 
  });

  socket.on('admin_del_q', (id) => {
    questionBank = questionBank.filter(q => q.id !== id);
    io.emit('admin_update_bank', questionBank);
  });

  socket.on('join_room', ({ pin, username, isHost }) => {
    const roomPin = String(pin).trim();
    socket.join(roomPin);
    
    if (!roomsData[roomPin]) {
      roomsData[roomPin] = { players: {}, startTime: 0, currentQuestion: null, stats: {}, currentQuestionIndex: 0 };
    }
    if (!isHost) {
      roomsData[roomPin].players[socket.id] = { username, score: 0, hasAnswered: false };
    }
    io.to(roomPin).emit('player_joined', { id: socket.id, username, isHost });
  });

  socket.on('host_send_question', (pin: string) => {
    const roomPin = String(pin).trim();
    const room = roomsData[roomPin];
    if (!room) return;

    const qIndex = room.currentQuestionIndex || 0;
    
    if (qIndex < questionBank.length) {
      const questionData = questionBank[qIndex];
      room.currentQuestion = questionData;
      room.startTime = Date.now();
      room.stats = { 'A': 0, 'B': 0, 'C': 0, 'D': 0 }; 

      for (let id in room.players) {
        room.players[id].hasAnswered = false;
      }

      room.currentQuestionIndex = qIndex + 1;

      // 👇 關鍵：把當前進度與總題數包裝傳給前端
      const { correctAnswer, ...clientQuestionData } = questionData;
      const payload = {
        ...clientQuestionData,
        currentQIndex: room.currentQuestionIndex,
        totalQuestions: questionBank.length
      };
      io.to(roomPin).emit('receive_question', payload);
    }
  });

  socket.on('submit_answer', ({ pin, answerId }) => {
    const roomPin = String(pin).trim();
    const room = roomsData[roomPin];
    const player = room?.players[socket.id];

    if (room && player && !player.hasAnswered) {
      player.hasAnswered = true;
      const timeElapsed = (Date.now() - room.startTime) / 1000;
      const tMax = room.currentQuestion.timeLimit;
      
      const isCorrect = (answerId === room.currentQuestion.correctAnswer);
      let earnedScore = 0;

      if (isCorrect) {
        earnedScore = Math.round(1000 * (1 - (timeElapsed / (2 * tMax))));
        if (earnedScore < 500) earnedScore = 500;
        if (earnedScore > 1000) earnedScore = 1000;
        player.score += earnedScore;
      }

      if (room.stats[answerId] !== undefined) {
        room.stats[answerId]++;
      }

      socket.emit('answer_result', { isCorrect, earnedScore, totalScore: player.score });
    }
  });

  socket.on('host_show_leaderboard', (pin: string) => {
    const roomPin = String(pin).trim();
    const room = roomsData[roomPin];
    if (room) {
      const playersArray = Object.values(room.players) as any[];
      const top5Players = playersArray.sort((a, b) => b.score - a.score).slice(0, 5);
      io.to(roomPin).emit('leaderboard_updated', top5Players);
    }
  });

  socket.on('host_show_review', (pin: string) => {
    const roomPin = String(pin).trim();
    const room = roomsData[roomPin];
    if (room) {
      io.to(roomPin).emit('review_updated', {
        question: room.currentQuestion,
        stats: room.stats,
        hasNextQuestion: room.currentQuestionIndex < questionBank.length 
      });
    }
  });

  socket.on('host_show_podium', (pin: string) => {
    const roomPin = String(pin).trim();
    const room = roomsData[roomPin];
    if (room) {
      const playersArray = Object.values(room.players) as any[];
      const top3Players = playersArray.sort((a, b) => b.score - a.score).slice(0, 3);
      io.to(roomPin).emit('podium_updated', top3Players);
    }
  });

  socket.on('disconnect', () => {
    console.log(`❌ 系統提示: 裝置斷線 (ID: ${socket.id})`);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 天空之島伺服器已啟動於 Port ${PORT}`);
});