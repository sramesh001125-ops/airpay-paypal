process.env.RAZORPAY_MODE = 'mock';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test-rzp-secret';
await import('./setup.js');
