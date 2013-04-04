var request = require('request');
var exec = require('child_process').exec;
var config = require('./config');

var nodeHost = 'standardsurvival.com'


function rollbarRecordDeploy(accessToken, username, revision) {
  var options = {
    uri: 'https://api.rollbar.com/api/1/deploy/',
    method: 'POST',
    form: {
      'access_token': accessToken,
      'environment': 'production',
      'revision': revision,
      'local_username': username,
    }
  }
  
  request(options, function(error, response, body) {
    if (error || response.statusCode >= 400) {
      console.log("Error recording deploy!\n" + body);
    } else {
      console.log("Deploy recorded successfully.");
    }
  });
}

// Update remote server code and restart node server
exec("ssh " + nodeHost + " 'bash -s' < remote_deploy.sh", function(error, stdout, stderr) {
  if (error) {
    console.log("Deploy failed!\n" + stderr);
    return;
  }
  
  console.log("Remote server deployed.");
  
  exec('whoami', function(error, stdout, stderr) {
    var username = stdout.trim();
    
    exec('git log -n 1 --pretty=format:"%H"', function(error, stdout, stderr) {
      var revision = stdout.trim();
      
      rollbarRecordDeploy(config.rollbar.accessToken, username, revision);
    });
  });
});