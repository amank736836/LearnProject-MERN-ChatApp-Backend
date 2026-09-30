import { v2 as cloudinary } from "cloudinary";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import { v4 as uuid } from "uuid";
import {
  cookieOptions,
  JWT_EXPIRES_IN,
  JWT_SECRET,
  userSocketIDs,
} from "../app.js";
import { errCheck, ErrorHandler } from "../middlewares/error.js";

const connectDB = (url) => {
  mongoose
    .connect(url, { dbName: "StealthyNote" })
    .then((data) => {
      console.log(`MongoDB connected to: ${data.connection.host}`);
    })
    .catch((err) => {
      err = errCheck(err);

      throw new Error(err);
    });
};

const sendToken = (res, user, code, message) => {
  const token = jwt.sign({ id: user._id }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });

  return res
    .status(code)
    .cookie(process.env.STEALTHY_NOTE_TOKEN_NAME, token, cookieOptions)
    .json({
      success: true,
      message,
      user,
    });
};

const getSockets = (users = []) => {
  return users.flatMap((user) => [...(userSocketIDs.get(user.toString()) || [])]);
};

const emitEvent = (req, event, users, data) => {
  const io = req.app.get("io");

  if (!io) {
    console.error("Socket.io instance is not available.");
    return;
  }

  const usersSocket = getSockets(users);

  io.to(usersSocket).emit(event, data);
};

const getBase64 = (file) =>
  `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;

const uploadFilesToCloudinary = async (files = []) => {
  const uploadPromises = files.map((file) => {
    return new Promise((resolve, reject) => {
      cloudinary.uploader.upload(
        getBase64(file),
        { folder: "StealthyNote", resource_type: "auto", public_id: uuid() },

        (error, result) => {
          if (error) {
            console.error("Error uploading file to Cloudinary:", error);
            reject(error);
          } else {
            resolve(result);
          }
        }
      );
    });
  });

  try {
    const results = await Promise.all(uploadPromises);

    const formattedResults = results.map((result) => {
      return {
        public_id: result.public_id,
        url: result.secure_url,
      };
    });

    return formattedResults;
  } catch (error) {
    console.error("Error uploading files:", error);
    throw new ErrorHandler("Failed to upload files to Cloudinary");
  }
};

const deleteFilesFromCloudinary = async (publicIds = []) => {
  const ids = publicIds.flat(Infinity).filter(Boolean);
  await Promise.all(ids.map((publicId) => new Promise((resolve, reject) => {
    cloudinary.uploader.destroy(publicId, { resource_type: "image", invalidate: true }, (error, result) => {
      if (error) return reject(error);
      if (result?.result === "not found") {
        return cloudinary.uploader.destroy(publicId, { resource_type: "raw", invalidate: true }, (rawError) => rawError ? reject(rawError) : resolve());
      }
      resolve();
    });
  })));
};

const sendForgotPasswordEmail = async ({
  email,
  username,
  verifyCode,
  baseUrl,
}) => {
  const Mail = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Forgot Your Password
    </title>
    <style>
        body {
            font-family: 'Arial', sans-serif;
            background-color: #f4f4f4;
            margin: 0;
            padding: 20px;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
        }
        .email-container {
            max-width: 600px;
            background: #ffffff;
            padding: 25px;
            border-radius: 10px;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
            text-align: center;
            border: 1px solid #ddd;
        }
        .header {
            font-size: 26px;
            font-weight: bold;
            color: #dc3545;
            margin-bottom: 15px;
        }
        .content {
            font-size: 16px;
            color: #333;
            line-height: 1.6;
        }
        .verification-code {
            font-size: 22px;
            font-weight: bold;
            color: #28a745;
            background: #eaf7ea;
            padding: 12px;
            display: inline-block;
            border-radius: 8px;
            margin: 15px 0;
            letter-spacing: 2px;
        }
        .forgot-button {
            display: inline-block;
            background-color: #dc3545;
            color: white;
            padding: 14px 30px;
            border-radius: 5px;
            text-decoration: none;
            font-weight: bold;
            font-size: 16px;
            margin-top: 15px;
            transition: background 0.3s;
        }
        .forgot-button:hover {
            background-color: #c82333;
        }
        .footer {
            margin-top: 20px;
            font-size: 13px;
            color: #777;
        }
        @media screen and (max-width: 600px) {
            .email-container {
                width: 90%;
                padding: 20px;
            }
            .header {
                font-size: 22px;
            }
            .verification-code {
                font-size: 18px;
                padding: 10px;
            }
            .forgot-button {
                font-size: 14px;
                padding: 12px 25px;
            }
        }
    </style>
</head>
<preview>Forgot Your Password</preview>
<body>
    <div class="email-container">
        <div class="header">Forgot Your Password</div>
        <div class="content">
            <p>Hello, <strong>${username}</strong>,</p>
            <p>We received a request to forgot your password. Use the verification code below to proceed:</p>
            <div class="verification-code">${verifyCode}</div>
            <p>Or, click the button below to forgot your password instantly:</p>
            <a href="${baseUrl}/forgot?identifier=${username}&verifyCode=${verifyCode}" 
            class="forgot-button">Forgot Password</a>
            <p>If you did not request this, you can safely ignore this email.</p>
        </div>
        <div class="footer">&copy; ${new Date().getFullYear()} Stealthy Note. All rights reserved.</div>
    </div>
</body>
</html>`;

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      service: "gmail",
      auth: {
        user: process.env.NODE_MAILER_EMAIL,
        pass: process.env.NODE_MAILER_PASSWORD,
      },
    });

    const mailOptions = {
      from: `Stealthy Note<${process.env.NODE_MAILER_EMAIL}>`,
      to: email,
      subject: `Stealthy Note - Forgot Your Password for ${username}`,
      text: `Forgot Your Password - Verification Code: ${verifyCode}`,
      html: Mail,
    };

    await transporter.verify(function (error, success) {
      if (error) {
        console.log("Server is not ready to take our messages", error);
      } else {
        console.log("Server is ready to take our messages", success);
      }
    });

    const response = await transporter.sendMail(mailOptions);

    if (response.rejected.length > 0) {
      console.error(
        "Failed to send forgot password code - Email",
        response.rejected
      );
      return {
        success: false,
        message: "Failed to send forgot password code - Email",
      };
    }

    return {
      success: true,
      message: "Forgot password code sent successfully - Email",
    };
  } catch (error) {
    console.error("Error sending forgot password code - Email", error);
    return {
      success: false,
      message: "Error sending forgot password code - Email",
    };
  }
};

const sendVerificationEmail = async ({
  email,
  username,
  verifyCode,
  baseUrl,
}) => {
  const Mail = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Email Verification</title>
    <style>
        body {
            font-family: 'Arial', sans-serif;
            background-color: #f8f9fa;
            margin: 0;
            padding: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
        }
        .email-container {
            max-width: 600px;
            background: #ffffff;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 4px 10px rgba(0, 0, 0, 0.1);
            text-align: center;
            border: 1px solid #ddd;
        }
        .header {
            font-size: 24px;
            font-weight: bold;
            color: #007bff;
            margin-bottom: 10px;
        }
        .content {
            font-size: 16px;
            color: #333;
            line-height: 1.6;
            margin-bottom: 20px;
        }
        .verification-code {
            font-size: 20px;
            font-weight: bold;
            color: #28a745;
            background: #eaf7ea;
            padding: 10px;
            display: inline-block;
            border-radius: 5px;
            margin: 15px 0;
            letter-spacing: 1.5px;
        }
        .verify-button {
            display: inline-block;
            background-color: #007bff;
            color: white;
            padding: 12px 25px;
            border-radius: 5px;
            text-decoration: none;
            font-weight: bold;
            margin-top: 10px;
        }
        .footer {
            margin-top: 20px;
            font-size: 12px;
            color: #777;
        }
    </style>
</head>
<preview>Verify Your Email</preview>
<body>
    <div class="email-container">
        <div class="header">Verify Your Email</div>
        <div class="content">
            <p>Hello, ${username}</p>
            <p>Thank you for signing up! Please confirm your email address by using the verification code below:</p>
            <div class="verification-code">${verifyCode}</div>
            <p>Alternatively, you can click the button below to verify your email:</p>
            <a href="${baseUrl}/verify?identifier=${username}&verifyCode=${verifyCode}"
             class="verify-button">Verify Email</a>
            <p>If you did not create an account, you can safely ignore this email.</p>
        </div>
        <div class="footer">&copy; ${new Date().getFullYear()} Stealthy Note. All rights reserved.</div>
    </div>
</body>
</html>
`;

  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      service: "gmail",
      auth: {
        user: process.env.NODE_MAILER_EMAIL,
        pass: process.env.NODE_MAILER_PASSWORD,
      },
    });

    const mailOptions = {
      from: `Stealthy Note<${process.env.NODE_MAILER_EMAIL}>`,
      to: email,
      subject: `Stealthy Note - Verify Your Email for ${username}`,
      text: `Verify Your Email - Verification Code: ${verifyCode}`,
      html: Mail,
    };

    await transporter.verify(function (error, success) {
      if (error) {
        console.log("Server is not ready to take our messages", error);
      } else {
        console.log("Server is ready to take our messages", success);
      }
    });

    const response = await transporter.sendMail(mailOptions);

    if (response.rejected.length > 0) {
      console.error("Failed to send verification email", response.rejected);
      return {
        success: false,
        message: "Failed to send verification email",
      };
    }

    return Promise.resolve({
      success: true,
      message: "Verification email send successfully",
    });
  } catch (error) {
    console.error("Failed to send verification email", error);
    return {
      success: false,
      message: "Failed to send verification email",
    };
  }
};

export {
  connectDB,
  deleteFilesFromCloudinary,
  emitEvent,
  getBase64,
  getSockets,
  sendForgotPasswordEmail,
  sendToken,
  sendVerificationEmail,
  uploadFilesToCloudinary,
};
