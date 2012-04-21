#!/usr/bin/env node
// --------------------------------------------------------------------------------------------------------------------

var fs = require('fs');

var inspect   = require('eyes').inspector();
var awssum    = require('awssum');
var amazon    = awssum.load('amazon/amazon');
var s3Service = awssum.load('amazon/s3');

var accessKeyId     = process.env.ACCESS_KEY_ID;
var secretAccessKey = process.env.SECRET_ACCESS_KEY;
var awsAccountId    = process.env.AWS_ACCOUNT_ID;

var argv = require('optimist')
    .usage('Usage: $0 --bucket name')
    .alias('bucket', 'b')
    .demand('b')
    .describe('b', 'bucket name to get the object from')
    .describe('debug', 'to turn debugging on')
    .argv;

// --------------------------------------------------------------------------------------------------------------------

var s3 = new s3Service(accessKeyId, secretAccessKey, awsAccountId, amazon.US_EAST_1);

console.log( 'Settings:');
if ( argv.d || argv.debug ) {
    console.log( '- Region          : ', s3.region() );
    console.log( '- EndPoint        : ', s3.host() );
    console.log( '- AccessKeyId     : ', s3.accessKeyId() );
    console.log( '- SecretAccessKey : ', s3.secretAccessKey().substr(0,3) + "..." );
    console.log( '- AwsAccountId    : ', s3.awsAccountId() );
}

console.log( '- Bucket          : ', argv.bucket);
console.log();

// --------------------------------------------------------------------------------------------------------------------

var options = {
    BucketName : argv.bucket,
};

console.log('Listing Bucket:');
s3.ListObjects(options, function(err, data) {
    if (err) {
        inspect(err, 'Error');
        return;
    }

    if ( argv.d || argv.debug ) {
        inspect(data.StatusCode, 'StatusCode');
        inspect(data.Headers, 'Headers');
        inspect(data.Body, 'Body');
    }

    data.Body.ListBucketResult.Contents.forEach(function(v, i) {
        // inspect(v, 'Item');
        console.log('' + v.LastModified + ' ' + v.ETag.substr(1, 32) + ' ' + v.Key + ' (' + v.Size + ')');
    });

});

// --------------------------------------------------------------------------------------------------------------------
