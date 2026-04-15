import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';

const app = express();
const server = http.createServer(app);

// 👇 新增這段：專門做給 Render 雲端主機的「健康檢查 (Health Check)」
app.get('/', (req, res) => {
  res.send('✅ 天空之島伺服器正常運作中！(Server is running)');
});

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const roomsData: Record<string, any> = {};

io.on('connection', (socket: Socket) => {
  console.log(`⚡ 系統提示: 裝置連線 (ID: ${socket.id})`);

  socket.on('join_room', ({ pin, username, isHost }) => {
    const roomPin = String(pin).trim();
    socket.join(roomPin);
    
    if (!roomsData[roomPin]) {
      roomsData[roomPin] = { players: {}, startTime: 0, currentQuestion: null, stats: {} };
    }
    if (!isHost) {
      roomsData[roomPin].players[socket.id] = { username, score: 0, hasAnswered: false };
    }
    io.to(roomPin).emit('player_joined', { id: socket.id, username, isHost });
  });

  socket.on('host_send_question', (pin: string) => {
    const roomPin = String(pin).trim();
    
    const questionData = {
      id: 1,
      text: "在《魔靈召喚》中，哪一個符文套裝的效果是「增加 25% 攻擊速度」？",
      correctAnswer: 'B', 
      options: [
        { id: 'A', text: "暴走 (Violent)", color: '#e53e3e' },
        { id: 'B', text: "迅捷 (Swift)", color: '#3182ce' },
        { id: 'C', text: "絕望 (Despair)", color: '#d69e2e' },
        { id: 'D', text: "激怒 (Rage)", color: '#805ad5' }
      ],
      timeLimit: 10 
    };

    roomsData[roomPin].currentQuestion = questionData;
    roomsData[roomPin].startTime = Date.now();
    // 初始化統計數據
    roomsData[roomPin].stats = { 'A': 0, 'B': 0, 'C': 0, 'D': 0 }; 

    for (let id in roomsData[roomPin].players) {
      roomsData[roomPin].players[id].hasAnswered = false;
    }

    const { correctAnswer, ...clientQuestionData } = questionData;
    io.to(roomPin).emit('receive_question', clientQuestionData);
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

      // 記錄該選項被選擇的次數
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

  // 新增：觸發賽後復盤
  socket.on('host_show_review', (pin: string) => {
    const roomPin = String(pin).trim();
    const room = roomsData[roomPin];
    if (room) {
      // 傳送完整題目(包含正確答案)與統計數據給前端
      io.to(roomPin).emit('review_updated', {
        question: room.currentQuestion,
        stats: room.stats
      });
    }
  });

  // 新增：觸發最終頒獎台 (取前 3 名)
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