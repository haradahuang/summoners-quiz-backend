import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';

const app = express();
const server = http.createServer(app);

app.get('/', (req, res) => {
  res.send('✅ 天空之島伺服器正常運作中！(Server is running)');
});

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// 全域題庫：現在支援 'choice' (單選) 與 'match' (配對) 兩種題型
let questionBank: any[] = [
  {
    id: 1,
    type: 'choice',
    text: "在《魔靈召喚》中，哪一個符文套裝的效果是「增加 25% 攻擊速度」？",
    correctAnswer: 'B', 
    options: [
      { id: 'A', text: "暴走 (Violent)", color: '#e53e3e' },
      { id: 'B', text: "迅捷 (Swift)", color: '#3182ce' },
      { id: 'C', text: "絕望 (Despair)", color: '#d69e2e' },
      { id: 'D', text: "激怒 (Rage)", color: '#805ad5' }
    ],
    timeLimit: 15 
  },
  {
    id: 2,
    type: 'match',
    text: "【魔靈觀察局】請將上方的魔靈與下方正確的「專屬美腿」配對！",
    topItems: [
      { id: 'T1', name: '殺手', img: 'https://github.com/user-attachments/assets/ec7f6791-4bb9-4f5d-8a55-a126615b7531' },
      { id: 'T2', name: '夢喵', img: 'https://github.com/user-attachments/assets/5e1c33d0-600e-40ea-aec2-8c2ae5ba1a57' },
      { id: 'T3', name: '光瓦', img: 'https://github.com/user-attachments/assets/22282544-280c-4b42-b828-4105be49f9d8' },
      { id: 'T4', name: '暗奧', img: 'https://github.com/user-attachments/assets/d1095420-621f-4e59-8463-a9c744e34939' }
    ],
    bottomItems: [
      { id: 'B1', img: 'https://github.com/user-attachments/assets/0513bf21-6aee-4e46-99c8-d504410c298a' },
      { id: 'B2', img: 'https://github.com/user-attachments/assets/5f1ed78c-d9d9-4491-aed6-ddc7ef677ce4' },
      { id: 'B3', img: 'https://github.com/user-attachments/assets/b1af9733-fcd9-4842-aa2d-de199b67a08a' },
      { id: 'B4', img: 'https://github.com/user-attachments/assets/b79bd322-07c4-4a4e-b517-f28510e8d722' }
    ],
    // 設定正確的配對組合 { 上方ID : 下方ID }
    correctMatches: { 'T1': 'B1', 'T2': 'B2', 'T3': 'B3', 'T4': 'B4' },
    timeLimit: 30 
  }
];

const roomsData: Record<string, any> = {};
const ADMIN_PASSWORD = 'admin'; 

io.on('connection', (socket: Socket) => {
  console.log(`⚡ 裝置連線 (ID: ${socket.id})`);

  socket.on('admin_login', (password) => {
    if (password === ADMIN_PASSWORD) socket.emit('admin_auth_success', questionBank);
    else socket.emit('admin_auth_fail');
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
    if (!isHost) roomsData[roomPin].players[socket.id] = { username, score: 0, hasAnswered: false };
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

      for (let id in room.players) room.players[id].hasAnswered = false;
      room.currentQuestionIndex = qIndex + 1;

      // 剔除正確答案，不讓前端看到
      const { correctAnswer, correctMatches, ...clientQuestionData } = questionData;
      io.to(roomPin).emit('receive_question', {
        ...clientQuestionData,
        currentQIndex: room.currentQuestionIndex,
        totalQuestions: questionBank.length
      });
    }
  });

  socket.on('submit_answer', ({ pin, answerData }) => {
    const roomPin = String(pin).trim();
    const room = roomsData[roomPin];
    const player = room?.players[socket.id];

    if (room && player && !player.hasAnswered) {
      player.hasAnswered = true;
      const timeElapsed = (Date.now() - room.startTime) / 1000;
      const tMax = room.currentQuestion.timeLimit;
      
      let isCorrect = false;

      // 判斷題型並給分
      if (room.currentQuestion.type === 'match') {
        const correct = room.currentQuestion.correctMatches;
        // 檢查玩家送出的配對是否與正確配對完全一致
        isCorrect = Object.keys(correct).every(k => correct[k] === answerData[k]) && 
                    Object.keys(answerData).length === Object.keys(correct).length;
      } else {
        isCorrect = (answerData === room.currentQuestion.correctAnswer);
        if (room.stats[answerData] !== undefined) room.stats[answerData]++;
      }

      let earnedScore = 0;
      if (isCorrect) {
        earnedScore = Math.round(1000 * (1 - (timeElapsed / (2 * tMax))));
        if (earnedScore < 500) earnedScore = 500;
        if (earnedScore > 1000) earnedScore = 1000;
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
    }
  });

  socket.on('host_show_review', (pin: string) => {
    const roomPin = String(pin).trim();
    if (roomsData[roomPin]) {
      io.to(roomPin).emit('review_updated', {
        question: roomsData[roomPin].currentQuestion,
        stats: roomsData[roomPin].stats,
        hasNextQuestion: roomsData[roomPin].currentQuestionIndex < questionBank.length 
      });
    }
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