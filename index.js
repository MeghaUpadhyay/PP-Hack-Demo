const config = require('./config');

const voiceit2 = require('voiceit2-nodejs')
let myVoiceIt = new voiceit2(config.apiKey, config.apiToken);
var numTries = 0;

const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

const express = require('express')
const bodyParser = require('body-parser');

var mysql = require('mysql');
var pool  = mysql.createPool({
   host     : 'remotemysql.com',
   user     : '58y5021f53',
   password : '1sxcXeilmn',
   database : '58y5021f53'
});

const PORT = process.env.PORT || 5000

express()
  .use(bodyParser.urlencoded({extended: true}))
  .use(bodyParser.json())
  .post('/incoming_call', (req, res) => incomingCall(req, res))
  .post('/enroll_or_verify', (req, res) => enrollOrVerify(req, res))
  .post('/enroll', (req, res) => enroll(req, res))
  .post('/process_enrollment', (req, res) => processEnrollment(req, res))
  .post('/verify', (req, res) => verify(req, res))
  .post('/process_verification', (req, res) => processVerification(req, res))
  .listen(PORT, () => console.log(`Listening on port ${ PORT }`))

const callerUserId = async (phone) => {
  try {
    const client = await pool.connect()
    const result = await client.query('SELECT userId FROM users where phone=\'' + phone + '\'');
    client.release();
    // Check for user in db
    if (Object.keys(result.rows).length !== 0) {
      return result.rows[0].userid;
    }
  } catch (err) {
      console.error(err);
  }
  return 0
};

const incomingCall = async (req, res) => {
  const twiml = new VoiceResponse();
  const phone = removeSpecialChars(req.body.From);
  const userId = await callerUserId(phone);

  // Check for user in VoiceIt db
  myVoiceIt.checkUserExists({
    userId :userId
  }, async (jsonResponse)=>{
    // User already exists
    if(jsonResponse.exists === true) {
      // Greet the caller when their account profile is recognized by the VoiceIt API.
      speak(twiml, "Welcome back to the Paypal offline payment service, your phone number has been recognized");
      // Let's provide the caller with an opportunity to enroll by typing `1` on
      // their phone's keypad. Use the <Gather> verb to collect user input
      const gather = twiml.gather({
        action: '/enroll_or_verify',
        numDigits: 1,
        timeout: 5
      });
      speak(gather, "Please press one to enroll");
      twiml.redirect('/enroll_or_verify?digits=TIMEOUT');
      res.type('text/xml');
      res.send(twiml.toString());

    } else {
      // Create a new user for new number
      myVoiceIt.createUser(async (jsonResponse)=>{
        speak(twiml, "Welcome back to the Paypal offline payment service, you are a new user and will now be enrolled");
        try {
          const client = await pool.connect()
          const result = await client.query('insert into users values ('+ phone +', \'' + jsonResponse.userId + '\')');
          client.release();
        } catch (err) {
          console.error(err);
          res.send("Error " + err);
        }

        twiml.redirect('/enroll');
        res.type('text/xml');
        res.send(twiml.toString());
      });
    }
  });
};

// Routing Enrollments & Verification
// ------------------------------------
// We need a route to help determine what the caller intends to do.
const enrollOrVerify = async (req, res) => {
  const digits = req.body.Digits;
  const phone = removeSpecialChars(req.body.From);
  const twiml = new VoiceResponse();
  const userId = await callerUserId(phone);
  // When the caller asked to enroll by pressing `1`, provide friendly
  // instructions, otherwise, we always assume their intent is to verify.
  if (digits == 1) {
    //Delete User's voice enrollments and re-enroll
    myVoiceIt.deleteAllEnrollments({
      userId: userId,
      }, async (jsonResponse)=>{
        console.log("deleteAllEnrollments JSON: ", jsonResponse.message);
        speak(twiml, "You have chosen to re enroll your voice for authentication, you will now be asked to say a phrase three times, then you will be able to log in with that phrase");
        twiml.redirect('/enroll');
        res.type('text/xml');
        res.send(twiml.toString());
    });

  } else {
    //Check for number of enrollments > 2
    myVoiceIt.getAllVoiceEnrollments({
      userId: userId
      }, async (jsonResponse)=>{
        speak(twiml, "You have chosen to authenticate with your Voice.");
        console.log("jsonResponse.message: ", jsonResponse.message);
        const enrollmentsCount = jsonResponse.count;
        console.log("enrollmentsCount: ", enrollmentsCount);
        if(enrollmentsCount > 2){
          twiml.redirect('/verify');
          res.type('text/xml');
          res.send(twiml.toString());
        } else{
          speak(twiml, "You do not have enough enrollments and need to re enroll your voice.");
          //Delete User's voice enrollments and re-enroll
          myVoiceIt.deleteAllEnrollments({
            userId: userId,
            }, async (jsonResponse)=>{
              console.log("deleteAllEnrollments JSON: ", jsonResponse.message);
              twiml.redirect('/enroll');
              res.type('text/xml');
              res.send(twiml.toString());
          });
        }
    });
  }
};

// Enrollment Recording
const enroll = async (req, res) => {
  const enrollCount = req.query.enrollCount || 0;
  const twiml = new VoiceResponse();
  speak(twiml, 'Please say the following phrase to enroll ');
  speak(twiml, config.chosenVoicePrintPhrase, config.contentLanguage);

  twiml.record({
    action: '/process_enrollment?enrollCount=' + enrollCount,
    maxLength: 5,
    trim: 'do-not-trim'
  });
  res.type('text/xml');
  res.send(twiml.toString());
};

// Process Enrollment
const processEnrollment = async (req, res) => {
  const userId = await callerUserId(removeSpecialChars(req.body.From));
  var enrollCount = req.query.enrollCount;
  const recordingURL = req.body.RecordingUrl + ".wav";
  const twiml = new VoiceResponse();

  function enrollmentDone(){
      enrollCount++;
      // VoiceIt requires at least 3 successful enrollments.
      if (enrollCount > 2) {
        speak(twiml, 'Thank you, recording received, you are now enrolled and ready to log in');
        twiml.redirect('/verify');
      } else {
        speak(twiml, 'Thank you, recording received, you will now be asked to record your phrase again');
        twiml.redirect('/enroll?enrollCount=' + enrollCount);
      }
  }

  function enrollAgain(){
    speak(twiml, 'Your enrollment was not successful, please try again');
    twiml.redirect('/enroll?enrollCount=' + enrollCount);
  }

  // Sleep and wait for Twillio to make file available
  await new Promise(resolve => setTimeout(resolve, 1000));
  myVoiceIt.createVoiceEnrollmentByUrl({
    userId: userId,
	  audioFileURL: recordingURL,
    phrase: config.chosenVoicePrintPhrase,
	  contentLanguage: config.contentLanguage,
	}, async (jsonResponse)=>{
      console.log("createVoiceEnrollmentByUrl json: ", jsonResponse.message);
      if ( jsonResponse.responseCode === "SUCC" ) {
        enrollmentDone();
      } else {
        enrollAgain();
      }

    res.type('text/xml');
    res.send(twiml.toString());
  });
}

// Verification Recording
const verify = async (req, res) => {
  var twiml = new VoiceResponse();

  speak(twiml, 'Please say the following phrase to verify your voice ');
  speak(twiml, config.chosenVoicePrintPhrase, config.contentLanguage);

  twiml.record({
    action: '/process_verification',
    maxLength: '5',
    trim: 'do-not-trim',
  });
  res.type('text/xml');
  res.send(twiml.toString());
};

// Process Verification
const processVerification = async (req, res) => {
  const userId = await callerUserId(removeSpecialChars(req.body.From));
  const recordingURL = req.body.RecordingUrl + '.wav';
  const twiml = new VoiceResponse();

  // Sleep and wait for Twillio to make file available
  await new Promise(resolve => setTimeout(resolve, 1000));
  myVoiceIt.voiceVerificationByUrl({
    userId: userId,
  	audioFileURL: recordingURL,
    phrase: config.chosenVoicePrintPhrase,
  	contentLanguage: config.contentLanguage,
  	}, async (jsonResponse)=>{
      console.log("createVoiceVerificationByUrl: ", jsonResponse.message);

      if (jsonResponse.responseCode == "SUCC") {
        speak(twiml, 'Verification successful!');
        speak(twiml,'Please enter phone number of the payment receiver');
        //Hang up
      } else if (numTries > 2) {
        //3 attempts failed
        speak(twiml,'We are unable to authenticate you, please redial and try again.');
      } else {
        switch (jsonResponse.responseCode) {
          case "STTF":
              speak(twiml, "Verification failed. It seems you may not have said your enrolled phrase. Please try again.");
              numTries = numTries + 1;
              twiml.redirect('/verify');
              break;
          case "FAIL":
              speak(twiml,"Your verification did not pass, please try again.");
              numTries = numTries + 1;
              twiml.redirect('/verify');
              break;
          case "SSTQ":
              speak(twiml,"Please speak a little louder and try again.");
              numTries = numTries + 1;
              twiml.redirect('/verify');
              break;
          case "SSTL":
              speak(twiml,"Please speak a little quieter and try again.");
              numTries = numTries + 1;
              twiml.redirect('/verify');
              break;
          default:
              speak(twiml,"Something went wrong. Your verification did not pass, please try again.");
              numTries = numTries + 1;
              twiml.redirect('/verify');
          }
      }
      res.type('text/xml');
      res.send(twiml.toString());
  });

};

function speak(twiml, textToSpeak, contentLanguage = "en-US"){
  twiml.say(textToSpeak, {
    voice: "alice",
    language: contentLanguage
  });
}

function removeSpecialChars(text){
  return text.replace(/[^0-9a-z]/gi, '');
}
