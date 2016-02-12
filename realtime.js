var http = require('http')
  , express = require('express')
  , bodyParser = require('body-parser')
  , socketio = require('socket.io')
  , request = require('request')
  , rollbar = require('rollbar')
  , events = require('events')
  , crypto = require('crypto')
  , StatsD = require('node-statsd')
  , logger = require('./logger')
  , jsonapi = require('./jsonapi')
  , streams = require('./streams')
  , consoleServer = require('./sockets/console')
  , chatServer = require('./sockets/chat')
  , util = require('./util');

var app = null;
var io = null;
var config = null;
var apis = {};
var stats = null;

var connections = {};

var serverStatus = {};

var isUserConnected = function(username) {
  var id;
  for (id in connections) {
    if (!connections.hasOwnProperty(id)) {
      continue;
    }

    var connection = connections[id];
    if (connection.username === username) {
      return true;
    }
  }
  return false;
};

var initUserChannel = function() {
  io
  .of('/user')
  .on('connection', function(socket) {
    socket.on('auth', function(data) {
      socket.removeAllListeners('auth');
      exports.authorize(socket, data, false, false, function(err, userId, username, uuid, isSuperuser, isModerator) {
        if (err) {
          console.log(err);
          return;
        }

        if (userId) {
          socket.join(userId);

          var options = {
            uri: 'http://' + config.website + '/api/v1/rts_user_connection',
            headers: {
              'X-Standard-Secret': config.authSecret,
              'X-Standard-User-Id': userId
            }
          };

          request(options, function(error, response, body) {
            if (error || response.statusCode != 200) {
              console.log(error);
            }
          });
        }
      });
    });
  });
};

var initServerStatusGetter = function(serverId) {
  var api = apis[serverId];

  var getter = function() {
    api.call('server_status', {minimal: true}, function(error, data) {
      if (error || !data) {
        logger.error('Error getting server status for server ' + serverId + ': ' + error);
      } else {
        data = data.data;

        if (data && data.players) {
          for (var i = 0; i < data.players.length; ++i) {
            var nicknameAnsi = data.players[i].nickname_ansi;
            if (nicknameAnsi) {
              data.players[i].nicknameAnsi = util.ansiConvert.toHtml(nicknameAnsi);
            }
          }

          serverStatus[serverId] = {
            players: data.players,
            numPlayers: data.numplayers,
            maxPlayers: data.maxplayers,
            load: data.load,
            tps: data.tps
          };

          stats.gauge('minecraft.server.' + serverId + '.players.count', data.numplayers);
          stats.gauge('minecraft.server.' + serverId + '.players.max', data.maxplayers);
          stats.gauge('minecraft.server.' + serverId + '.tps', data.tps);
        }
      }

      setTimeout(getter, 2000);
    });
  };

  getter();
};

var generateAuthToken = function(content) {
  var hash = crypto.createHmac('sha256', config.authSecret);
  return hash.update(content).digest('hex');
};

exports.authorize = function(socket, data, elevated, allowAnonymous, callback) {
  var authData = data.authData;
  if (authData && authData.token) {
    var userId = authData.user_id;
    var username = authData.username;
    var uuid = authData.uuid;
    var isSuperuser = authData.is_superuser;
    var isModerator = authData.is_moderator;
    var token = authData.token;

    var content = [userId, username, uuid, isSuperuser, isModerator].join('-');

    var checkToken = generateAuthToken(content);

    if (token === checkToken && (!elevated || isSuperuser)) {
      socket.emit('authorized');
      return callback(null, userId, username, uuid, isSuperuser, isModerator);
    } else {
      return socket.emit('unauthorized');
    }
  } else if (allowAnonymous) {
    socket.emit('authorized');
    return callback(null);
  } else {
    return socket.emit('unauthorized');
  }
};

exports.addConnection = function(socket, type) {
  var address = 'unknown';
  if (socket.handshake) {
    address = socket.handshake.headers['x-real-ip'] || socket.handshake.address.address;
  }

  var unique = true;

  var userId = socket.userId;
  var username = socket.username;
  var uuid = socket.uuid;

  var connection = {
    connectionTime: Math.floor(new Date().getTime() / 1000),
    address: address,
    type: type,
    socketId: socket.id,
    active: true
  };

  if (userId) {
    connection.userId = userId;
    connection.username = username;
    connection.uuid = uuid;

    unique = !isUserConnected(username);
  }

  connections[socket.id] = connection;

  return unique;
};

exports.removeConnection = function(socket) {
  var unique = true;

  var connection = connections[socket.id];
  delete connections[socket.id];

  var username = connection.username;
  if (username) {
    unique = !isUserConnected(username);
  }

  return unique;
};

exports.getActiveWebChatUsers = function(redactAddress, nicknameMap) {
  var userMap = {};
  var result = [];

  var id;
  for (id in connections) {
    if (!connections.hasOwnProperty(id)) {
      continue;
    }

    var connection = connections[id];
    if (connection.type == 'chat' && connection.username && connection.uuid &&
        !userMap[connection.username]) {
      userMap[connection.username] = true;

      var user = {
        active: connection.active,
        username: connection.username,
        uuid: connection.uuid
      };

      if (nicknameMap.hasOwnProperty(connection.uuid)) {
        user.nickname = nicknameMap[connection.uuid];
      }

      if (!redactAddress) {
        user.address = connection.address;
      }

      result.push(user);
    }
  }

  return result;
};

exports.init = function(_config, callback) {
  config = _config;

  app = express();
  app.use(bodyParser.json());

  app.get('/users', function(req, res) {
    res.send({
      users: exports.getActiveWebChatUsers(true)
    });
  });

  app.post('/event/user', function (req, res) {
    var secret = req.headers['x-standard-secret'];

    if (secret !== config.authSecret) {
      return res.status(403).send({
        'err': 'Unauthorized'
      });
    }

    var data = req.body;

    io.of('user').in(data.user_id).emit(data.action, data.payload);

    res.send({});
  });

  stats = new StatsD(config.statsd);
  
  if (config.rollbar) {
    rollbar.init(config.rollbar.accessToken, {
      environment: config.rollbar.environment,
      root: config.rollbar.root,
      branch: config.rollbar.branch
    });
    
    if (!config.debug) {
      rollbar.handleUncaughtExceptions();
    }
  }
  
  var options = {
    uri: 'http://' + config.website + '/api/v1/servers'
  };
  
  request(options, function(error, response, body) {
    if (error || response.statusCode != 200) {
      return callback(new Error("Not able to get list of servers from api!"));
    }
    
    var data = JSON.parse(body);
    
    var i;
    for (i = 0; i < data.servers.length; ++i) {
      var server = data.servers[i];

      if (!server.online) {
        continue;
      }

      var id = server.id;
      var address = server.address;
      
      apis[id] = new jsonapi.JSONAPI({
        hostname: address,
        port: config.mcApiPort,
        username: config.mcApiUsername,
        password: config.mcApiPassword,
        salt: config.mcApiSalt
      });

      initServerStatusGetter(id);
    }
      
    return callback();
  });
};

exports.start = function() {
  var server = app.listen(config.port);
  io = socketio.listen(server);
  
  streams.startStreams();
  
  consoleServer.start(io, apis);
  chatServer.start(io, apis);

  initUserChannel();
};

exports.apis = apis;
exports.connections = connections;
exports.serverStatus = serverStatus;
