import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: process.env.EMAIL_SECURE === "true", // true for 465, false for other ports
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

export const sendOTPEmail = async (to, otp) => {
    try {
        const mailOptions = {
            from: process.env.EMAIL_FROM || '"Chatte No-Reply" <no-reply@chattie.com>',
            to,
            subject: "Your Password Reset OTP",
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e1e1e1; rounded: 10px;">
                    <h2 style="color: #2563eb; text-align: center;">Password Reset Request</h2>
                    <p>Hello,</p>
                    <p>You requested a password reset for your support user account. Use the following One-Time Password (OTP) to proceed. This OTP is valid for 2 minutes.</p>
                    <div style="background-color: #f3f4f6; padding: 15px; text-align: center; font-size: 24px; font-weight: bold; letter-spacing: 5px; color: #1f2937; border-radius: 8px; margin: 20px 0;">
                        ${otp}
                    </div>
                    <p>If you did not request this, please ignore this email or contact your administrator.</p>
                    <p style="font-size: 13px; color: #ef4444; font-weight: bold; text-align: center; margin-top: 20px;">
                        ⚠️ This is an automated email. Please do not reply to this message.
                    </p>
                    <hr style="border: 0; border-top: 1px solid #e1e1e1; margin: 20px 0;">
                    <p style="font-size: 12px; color: #6b7280; text-align: center;">© ${new Date().getFullYear()} Chatte. All rights reserved.</p>
                </div>
            `,
        };

        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        return false;
    }
};
