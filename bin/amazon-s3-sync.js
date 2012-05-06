#!/usr/bin/env node
// --------------------------------------------------------------------------------------------------------------------

var fs = require('fs');
var crypto = require('crypto');

var fmt = require('fmt');
var async = require('async');
var tmp = require('tmp');
var mkdirp = require('mkdirp');

var awssum    = require('awssum');
var amazon    = awssum.load('amazon/amazon');
var s3Service = awssum.load('amazon/s3');

var accessKeyId     = process.env.ACCESS_KEY_ID;
var secretAccessKey = process.env.SECRET_ACCESS_KEY;
var awsAccountId    = process.env.AWS_ACCOUNT_ID;

// --------------------------------------------------------------------------------------------------------------------

var argv = require('optimist')
    .usage('Usage: $0 --bucket name [--concurrency n]')

    .demand('b')
    .alias('b', 'bucket')
    .describe('b', 'bucket to sync with')

    .alias('c', 'concurrency')
    .default('c', 3)
    .describe('c', 'concurrency level for uploads/downloads')

    .describe('debug', 'to turn debugging on')
    .argv;

// --------------------------------------------------------------------------------------------------------------------

var s3 = new s3Service(accessKeyId, secretAccessKey, awsAccountId, amazon.US_EAST_1);

fmt.sep();
fmt.title('amazon-s3-sync.js');
fmt.field('Bucket', argv.bucket);
fmt.field('Concurrency', argv.concurrency);
fmt.line();

// set up some queues so that we can check, download and upload things
var checkItemIsLocalQueue = async.queue(checkItemIsLocal, argv.concurrency);
var downloadItemQueue     = async.queue(downloadItem, argv.concurrency);
var checkMd5IsSameQueue   = async.queue(checkMd5IsSame, argv.concurrency);

s3BucketList(argv.bucket, function(items) {
    fmt.field('ItemCount', items.length);
    fmt.line();

    // now that we have the list, we can start checking to see if each of these items is also local
    items.forEach(function(item, i) {
        // ignore any keys that look like directories (the ones that the Amazon AWS Console creates)
        if ( item.Size === '0' && item.Key.charAt(item.Key.length-1) === '/' ) {
            fmt.field('IgnoringKey', 'Key looks like a directory: ' + item.Key);
            return;
        }

        checkItemIsLocalQueue.push(item);
    });

    // we can also start reading all the directories and c
});

// --------------------------------------------------------------------------------------------------------------------

// righto, there are two things we want to do here:
// (1) get a list of all files in this directory, and see if it exists in S3 already
// (2) get a list of all files in S3 and check to see if they are local
// but firstly, we need to get a list of all S3 files

// --------------------------------------------------------------------------------------------------------------------

function checkItemIsLocal(item, callback) {
    fmt.field('CheckKeyHasFile', item.Key);

    // firstly, check if the file exists
    fs.stat(item.Key, function(err, stats) {
        if ( err ) {
            // this file doesn't exist locally, so push it onto the download queue
            fmt.field('NoFileExistsForKey', item.Key);
            downloadItemQueue.push(item);
            callback();
            return;
        }

        // ok, we know there is a file, but if the filesize is different, it needs to go on the output queue
        if ( stats.size !== parseInt(item.Size, 10) ) {
            // console.log('File in S3 and local file are of different sizes : ' + item.Key);
            fmt.field('SizeMismatch', item.Key + ' (file=' + stats.size + ', item=' + item.Size + ')');
            // no more queues to add this item to
            callback();
            return;
        }

        // filesizes are the same, so check the MD5s are the same
        fmt.field('FileSizeSameAsKey', item.Key);
        checkMd5IsSameQueue.push(item);
        callback();
    });
}

function checkMd5IsSame(item, callback) {
    fmt.field('ComparingMD5s', item.Key + ' (' + item.ETag + ')' );

    // get the MD5 of this file (we know it exists)
    fs.readFile(item.Key, function(err, data) {
        // get the MD5 of this file
        var md5;

        // get the MD5 of this file
        var md5 = crypto.createHash('md5');
        var stream = fs.ReadStream(item.Key);
        stream.on('data', function(data) {
            md5.update(data);
        });
        stream.on('end', function() {
            var md5hex = md5.digest('hex');
            // fmt.field('Md5OfKey', item.Key + '=' + item.ETag);
            // fmt.field('Md5OfFile', item.Key + '=' + md5hex);
            fmt.field('ComparingMd5s', item.Key + ' (file="' + md5hex + '", key=' + item.ETag + ')');

            // check if the calculated MD5 is the same as the ETag in the S3 item
            if ( item.ETag === '"' + md5hex + '"' ) {
                // nothing to do
                fmt.field('Md5OfFileAndKeySame', item.Key);
            }
            else {
                // different, just tell the user they are different
                fmt.field('MD5Mismatch', item.Key);
            }
            callback();
        });

    });
}

function downloadItem(item, callback) {
    fmt.field('Downloading', item.Key);
    var options = {
        BucketName : argv.bucket,
        ObjectName : item.Key,
    };
    s3.GetObject(options, function(err, data) {
        if (err) {
            fmt.field('ErrorDownloading', err);
            callback();
            return;
        }

        fmt.field('FileDownloaded', item.Key);

        tmp.file({ template : '/tmp/tmp-XXXXXXXX.' + process.pid, keep : true }, function(err, tmpfile, fd) {
            if ( err ) {
                fmt.field('MkTempError', err);
                callback();
                return;
            }

            fmt.field('TmpFileCreated', tmpfile);

            fs.write(fd, data.Body, 0, data.Body.length, 0, function(err, written, buffer) {
                if ( err ) {
                    fmt.field('ErrWritingFile', err);
                    callback();
                    return;
                }

                fmt.field('Written', '' + written + ' bytes to tmpfile' );

                // all ok, now close the file
                fs.close(fd, function(err) {
                    if ( err ) {
                        fmt.field('ErrClosingFile', err);
                        callback();
                        return;
                    }

                    fmt.field('FileClosed', tmpfile);

                    // make sure the directory exists
                    mkdirp(item.Key.substr(0, item.Key.lastIndexOf('/')), function (err) {
                        if ( err ) {
                            fmt.field('ErrMakingDir', err);
                            callback();
                            return;
                        }

                        // finally, let's move it into place
                        fs.rename(tmpfile, item.Key, function(err) {
                            if ( err ) {
                                fmt.field('ErrRenamingTmpFileToKey', err);
                                callback();
                                return;
                            }

                            fmt.field('FileRenamed', tmpfile + ' -> ' + item.Key);

                            // absolutely everything went positively well!
                            callback();
                        });
                    });
                });
            });
        });
    });
}

function s3BucketList(bucket, callback) {
    var items = [];

    function doRequest(marker) {
        var options = {
            BucketName : argv.bucket,
        };
        if ( marker ) {
            if ( argv.d || argv.debug ) {
                console.log('Doing request at marker ' + marker);
            }
            options.Marker = marker;
        }

        s3.ListObjects(options, function(err, data) {
            if (err) {
                console.log('Error:', err);
                process.exit(1);
            }

            // loop through all the items and add them on to our saved list
            data.Body.ListBucketResult.Contents.forEach(function(v, i) {
                items.push(v);
            });

            // if we have any more, call
            if (data.Body.ListBucketResult.IsTruncated === 'true') {
                doRequest(data.Body.ListBucketResult.Contents[data.Body.ListBucketResult.Contents.length-1].Key);
            }
            else {
                // all finished
                callback(items);
            }
        });

    }

    // start the recursion off
    doRequest();
}

// --------------------------------------------------------------------------------------------------------------------
