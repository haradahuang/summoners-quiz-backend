import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';

const app = express();
const server = http.createServer(app);

app.get('/', (req, res) => { res.send('✅ 天空之島伺服器正常運作中！'); });

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let questionBank: any[] = [];
const roomsData: Record<string, any> = {};
const ADMIN_PASSWORD = 'admin'; 

io.on('connection', (socket: Socket) => {
  socket.on('admin_login', (password) => {
    if (password === ADMIN_PASSWORD) socket.emit('admin_auth_success', questionBank);
    else socket.emit('admin_auth_fail');
  });

  socket.on('admin_add_q', (newQ) => {
    newQ.id = Date.now(); questionBank.push(newQ); io.emit('admin_update_bank', questionBank); 
  });

  socket.on('admin_del_q', (id) => {
    questionBank = questionBank.filter(q => q.id !== id); io.emit('admin_update_bank', questionBank);
  });

  socket.on('join_room', ({ pin, username, isHost }) => {
    const roomPin = String(pin).trim();
    socket.join(roomPin);
    
    if (!roomsData[roomPin]) {
      roomsData[roomPin] = { players: {}, startTime: 0, currentQuestion: null, stats: {}, currentQuestionIndex: 0 };
    } else if (isHost) {
      roomsData[roomPin].currentQuestionIndex = 0;
      roomsData[roomPin].currentQuestion = null;
      for (let id in roomsData[roomPin].players) {
        roomsData[roomPin].players[id].score = 0;
        roomsData[roomPin].players[id].hasAnswered = false;
      }
    }

    if (!isHost) roomsData[roomPin].players[socket.id] = { username, score: 0, hasAnswered: false };
    
    // 👇 修復 1：每次有人加入，就抓出目前房間「所有人」的名單，然後同步給所有人
    const currentPlayers = Object.values(roomsData[roomPin].players).map((p: any) => p.username);
    io.to(roomPin).emit('update_players', currentPlayers);
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

      if (room.currentQuestion.type === 'match') {
        const correct = room.currentQuestion.correctMatches;
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