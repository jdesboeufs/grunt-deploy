'use strict';

var defaultOptions = { 
    servers: [
        {
            host: 'isogeo-node.cloudapp.net',
            port: 1022,
            user: 'deploy'
        },
        {
            host: 'isogeo-node.cloudapp.net',
            port: 2022,
            user: 'deploy'
        }
    ],
    nodeVersion: 'v0.10.25',
    concurrency: 2,
    https: false,
    excludeDirs: [],
    includeDirs: [],
    proxyingWebSockets: false
};

var rsync = require('rsyncwrapper').rsync;
var SSHConnection = require('ssh2');
var async = require('async');
var _ = require('underscore');

module.exports = function (grunt) {
    grunt.registerMultiTask('deploy', 'Deploys project instances.', function () {
        var taskDone = this.async();
        var nvmrc = grunt.file.read('.nvmrc');
        if (nvmrc && nvmrc.length) defaultOptions.nodeVersion = nvmrc.trim();
        var options = this.options(defaultOptions);
        var data = this.data;
        var envVars = grunt.file.read(data.env) + 'PATH=$PATH:/opt/nvm/' + options.nodeVersion + '/bin\n';
        grunt.file.write('.deploy/env', envVars);
        var nginxConfig = grunt.template.process(grunt.file.read(__dirname + '/templates/nginx-config.tmpl'), { data: _.extend({}, data, options) });
        grunt.file.write('.deploy/nginx.conf', nginxConfig);
        async.forEach(options.servers, function(server, instanceDone) {
            var conn = new SSHConnection();
            conn.on('error', function(err) { console.log('Connection :: error :: ' + err); });

            var sshConnect = function(stepDone) {
                grunt.log.writeln(server.port + ':ssh-connect');
                conn.on('ready', function() {
                    stepDone();
                });
                conn.connect({
                    host: server.host,
                    port: server.port,
                    username: server.user,
                    privateKey: grunt.file.read(process.env.HOME + '/.ssh/id_rsa')
                });
            };

            var stopApp = function(stepDone) {
                grunt.log.writeln(server.port + ':stop-app');
                conn.exec('sudo stop ' + data.projectName + ' || true', function(err, stream) {
                    stream.on('exit', function(code) {
                        if (code !== 0) return stepDone(new Error('Error in stopApp'));
                        stepDone();
                    });
                });
            };

            var startApp = function(stepDone) {
                grunt.log.writeln(server.port + ':start-app');
                conn.exec('sudo start ' + data.projectName, function(err, stream) {
                    stream.on('exit', function(code) {
                        if (code !== 0) return stepDone(new Error('Error in startApp'));
                        stepDone();
                    });
                });
            };

            var rsyncProject = function(stepDone) {
                grunt.log.writeln(server.port + ':rsync');
                rsync({
                    ssh: true,
                    port: server.port,
                    exclude: _.union(['/var/www/*/working_dir/.git', '/var/www/*/working_dir/node_modules/'], options.excludeDirs),
                    include: options.includeDirs,
                    syncDestIgnoreExcl: true,
                    args: ['--verbose', '--archive', '--compress'],
                    src: './',
                    dest: server.user + '@' + server.host + ':/var/www/' + data.projectName + '/working_dir'
                }, stepDone);
            };

            var prepareDir = function(stepDone) {
                grunt.log.writeln(server.port + ':prepare-dir');
                var commands = [
                    'mkdir -p /var/www/' + data.projectName+ '/working_dir'
                ];
                conn.exec(commands.join(' && '), function(err, stream) {
                    stream.on('exit', function(code) {
                        if (code !== 0) return stepDone(new Error('Error in prepareDir'));
                        stepDone();
                    });
                });
            };

            var installNodeVersion = function(stepDone) {
                grunt.log.writeln(server.port + ':node-version');
                conn.exec('source /opt/nvm/nvm.sh && nvm install ' + options.nodeVersion, function(err, stream) {
                    stream.on('exit', function(code) {
                        if (code !== 0) return stepDone(new Error('Error in installNodeVersion'));
                        stepDone();
                    });
                });
            };

            var npmInstall = function(stepDone) {
                grunt.log.writeln(server.port + ':npm-install');
                var commands = [
                    'cd /var/www/' + data.projectName + '/working_dir',
                    '/opt/nvm/' + options.nodeVersion + '/bin/npm install --production'
                ];
                conn.exec(commands.join(' && '), function(err, stream) {
                    stream.on('exit', function(code) {
                        if (code !== 0) return stepDone(new Error('Error in npmInstall'));
                        stepDone();
                    });
                }); 
            };

            var upstartScript = function(stepDone) {
                grunt.log.writeln(server.port + ':upstart');
                var command = [
                    'cd /var/www/' + data.projectName + '/working_dir &&',
                    'sudo foreman export upstart /etc/init',
                    '--app ' + data.projectName,
                    '--port ' + data.instancePort,
                    '--log /var/www/' + data.projectName + '/logs',
                    '--env .deploy/env',
                    '--user deploy',
                    '--concurrency web=' + options.concurrency
                ];
                conn.exec(command.join(' '), function(err, stream) {
                    stream.on('data', function(data) {
                        console.log(data.toString());
                    });
                    stream.on('exit', function(code) {
                        if (code !== 0) return stepDone(new Error('Error in upstartScript'));
                        stepDone();
                    });
                });
            };

            var linkNginxConfigAndReload = function(stepDone) {
                grunt.log.writeln(server.port + ':nginx-reload');
                conn.exec('sudo service nginx reload', function(err, stream) {
                    stream.on('exit', function(code) {
                        if (code !== 0) return stepDone(new Error('Error in linkNginxConfigAndReload'));
                        stepDone();
                    });
                });
            };

            var sshDisconnect = function(stepDone) {
                grunt.log.writeln(server.port + ':ssh-end');
                conn.end();
                stepDone();
            };

            async.series([
                sshConnect,
                stopApp,
                prepareDir,
                installNodeVersion,
                rsyncProject,
                npmInstall,
                upstartScript,
                startApp,
                linkNginxConfigAndReload,
                sshDisconnect
            ], instanceDone);
        }, taskDone);
    });
};
