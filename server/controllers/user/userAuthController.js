const User = require("../../models/User");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const OTP = require("../../models/Otp");

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

const signUp = async (req, res) => {
  const { firstName, lastName, email, phone, password, otp } = req.body;
  if (!firstName || !lastName || !email || !phone || !password || !otp) {
    return res.status(400).json({ message: "Please fill in all fields." });
  }
  try {
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already in use." });
    }

    const checkOtp = await OTP.find({ email }).sort({ createdAt: -1 }).limit(1);
    if (checkOtp.length === 0 || checkOtp[0].otp !== otp) {
      return res.status(422).json({ message: "Invalid OTP" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      firstName,
      lastName,
      email,
      phone,
      password: hashedPassword,
    });
    const savedUser = await user.save();

    const accessToken = jwt.sign(
      { userInfo: { id: user._id, role: user.role } },
      process.env.ACCESS_TOKEN_SECRET,
      {
        expiresIn: "1h",
      }
    );
    const refreshToken = jwt.sign(
      { id: user._id, role: user.role },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "1h" }
    );

    res.cookie("jwt", refreshToken, {
      httpOnly: true,
      secure: false,
      sameSite: "lax", // Use lax for local dev
      maxAge: 60 * 60 * 1000,
    });
    res.status(201).json({
      message: "User created successfully",
      accessToken,
      role: user.role,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error creating user" });
  }
};

const login = async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: "Please fill in all fields." });
  }
  try {
    const user = await User.findOne({ email });
    if (!user) {
      return res
        .status(401)
        .json({ message: "Email or password is incorrect" });
    }
    // if (!user.password) {
    //   return res.status(400).json({ message: "This account uses Google sign-in. Please use that method or set a password." });
    // }
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res
        .status(401)
        .json({ message: "Email or password is incorrect" });
    }
    if (user.isBlocked) {
      return res.status(403).json({ message: "Your account has been blocked" });
    }
    const accessToken = jwt.sign(
      { userInfo: { id: user._id, role: user.role } },
      process.env.ACCESS_TOKEN_SECRET,
      {
        expiresIn: "1h",
      }
    );
    const refreshToken = jwt.sign(
      { id: user._id, role: user.role },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "1h" }
    );

    res.cookie("jwt", refreshToken, {
      httpOnly: true,
      secure: false,
      sameSite: "lax", // Use lax for local dev
      maxAge: 60 * 60 * 1000,
    });
    res.status(200).json({
      message: `${user.firstName} logged in successfully`,
      accessToken,
      role: user.role,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error logging in" });
  }
};

const googleSignIn = async (req, res) => {
  const { tokenId } = req.body;
  if (!tokenId) {
    return res
      .status(400)
      .json({ message: "No token provided for goole signin" });
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken: tokenId,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const {
      email_verified,
      email,
      given_name,
      family_name,
      sub: googleId,
    } = payload;
    if (!email_verified) {
      return res
        .status(400)
        .json({ message: "Google account email not verified." });
    }
    let user = await User.findOne({ email });
    if (!user) {
      user = await User.create({
        email,
        firstName: given_name,
        lastName: family_name,
        email,
        googleId,
        password: "",
        // isVerified: true,
      });
      await user.save();
    } else {
      if (user.isBlocked) {
        return res
          .status(403)
          .json({ message: "Your account has been blocked" });
      }
      if (!user.googleId) {
        user.googleId = googleId;
        await user.save();
      }
    }

    const accessToken = jwt.sign(
      { userInfo: { id: user._id, role: user.role } },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: "1h" }
    );

    const refreshToken = jwt.sign(
      { id: user._id, role: user.role },
      process.env.REFRESH_TOKEN_SECRET,
      { expiresIn: "1h" }
    );

    res.cookie("jwt", refreshToken, {
      httpOnly: true,
      secure: false, // change to true in production when using HTTPS
      sameSite: "lax",
      maxAge: 60 * 60 * 1000, // 1 hour
    });

    res.status(200).json({
      message: `${user.firstName} logged in successfully via Google`,
      accessToken,
      role: user.role,
    });
  } catch (error) {
    console.error("Google Sign-In Error: ", error);
    res.status(500).json({ message: "Error during Google sign in" });
  }
};

const checkResetToken=async(req,res)=>{
  try {
    const resetToken = req.cookies?.resetToken;
    if (!resetToken) return res.status(401).json({ message: "Unauthorized or token expired" });

    // Verify token
    const decoded = jwt.verify(resetToken, process.env.RESET_TOKEN_SECRET);
    if (!decoded.email) return res.status(401).json({ message: "Invalid token" });
    const user = await User.findOne({ email: decoded.email });
    if (!user) return res.status(401).json({ message: "Invalid token" });

    res.status(200).json({ message: "Token valid" });
  } catch (error) {
    console.log(error)
    res.status(401).json({ message: "Invalid or expired token" });
  }
}

const resetPassword = async (req, res) => {
  try {
    const { newPassword } = req.body;
    if (!newPassword)
      return res.status(400).json({ message: "New password is required" });
    const resetToken = req.cookies?.resetToken;
    if (!resetToken)
      return res.status(401).json({ message: "Unauthorized or token expired" });

    const decoded = jwt.verify(resetToken, process.env.RESET_TOKEN_SECRET);
    const user = await User.findOne({ email: decoded.email });
    if (!user) return res.status(404).json({ message: "User not found" });
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();
    res.status(200).json({ message: "Password reset successfully" });
  } catch (error) {
    console.error("Error during password reset: ", error);
    res.status(500).json({ message: "Error during password reset" });
  }
};
module.exports = { signUp, login, googleSignIn,resetPassword,checkResetToken };
