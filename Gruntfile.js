module.exports = function (grunt) {
    require('matchdep').filterDev('grunt-*').forEach(grunt.loadNpmTasks);

    grunt.initConfig({
        jshint: {
            all: [
                'tasks/**/*.js',
                '*.js'
            ],
            options: {
                jshintrc: '.jshintrc',
            }
        }
    });

    grunt.registerTask('default', ['jshint']);
};
