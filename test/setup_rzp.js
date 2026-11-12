import './setup.js'; // sets the in-memory DB and mock modes first
process.env.RAZORPAY_MODE = 'mock';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-rzp-secret';
