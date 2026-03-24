import express from 'express';
import { dbStorage } from '../utils/db-storage';
import { hashPassword, comparePassword, generateToken, verifyToken, createSafeUser } from '../utils/auth';
import { getPublicServerBase } from '../utils/public-url';
import {
  getDefaultAvatarUrl,
  getPigsailAvatarUrl,
  resolveAvatarInputForRegister
} from '../utils/avatar-storage';
import { ensurePigsailAvatarSynced } from '../utils/pigsail-avatar-sync';
import { RegisterRequest, LoginRequest, ApiResponse, Message } from '../types';

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, displayName, password, avatar }: RegisterRequest = req.body;

    // Validation
    if (!username || !displayName || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username, display name, and password are required'
      } as ApiResponse);
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'Password must be at least 6 characters long'
      } as ApiResponse);
    }

    // Check if username already exists
    const existingUser = await dbStorage.getUserByUsername(username);
    if (existingUser) {
      return res.status(409).json({
        success: false,
        error: 'Username already exists'
      } as ApiResponse);
    }

    // Hash password and create user
    const hashedPassword = await hashPassword(password);
    const publicBase = getPublicServerBase(req);
    const defaultAvatar = getDefaultAvatarUrl(publicBase);
    const finalAvatar =
      avatar && String(avatar).trim()
        ? await resolveAvatarInputForRegister(String(avatar).trim(), username, publicBase)
        : defaultAvatar;

    const user = await dbStorage.createUser({
      username,
      displayName,
      email: `${username}@example.com`, // Add a default email
      passwordHash: hashedPassword,
      avatar: finalAvatar
    });

    console.log('✅ Registration debug - User created with avatar:', user.avatar);

    // Generate token
    const token = generateToken(user);

    // Auto-add pigsail user and send welcome message
    try {
      await addPigsailAsFriendAndSendWelcome(user, publicBase);
    } catch (error) {
      console.error('Failed to add pigsail user:', error);
      // Don't fail registration if this fails
    }

    res.status(201).json({
      success: true,
      data: {
        user: createSafeUser(user, publicBase),
        token
      },
      message: 'User registered successfully'
    } as ApiResponse);

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    } as ApiResponse);
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password }: LoginRequest = req.body;

    // Validation
    if (!username || !password) {
      return res.status(400).json({
        success: false,
        error: 'Username and password are required'
      } as ApiResponse);
    }

    // Find user
    const user = await dbStorage.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      } as ApiResponse);
    }

    // Check password
    const isValidPassword = await comparePassword(password, user.passwordHash);
    if (!isValidPassword) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      } as ApiResponse);
    }

    // Update last seen
    await dbStorage.updateLastSeen(user.id);

    // Generate token
    const token = generateToken(user);

    res.json({
      success: true,
      data: {
        user: createSafeUser(user, getPublicServerBase(req)),
        token
      },
      message: 'Login successful'
    } as ApiResponse);

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    } as ApiResponse);
  }
});

// Get current user info
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'No token provided'
      } as ApiResponse);
    }

    const decoded = verifyToken(token);
    const user = await dbStorage.getUserById(decoded.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      } as ApiResponse);
    }

    res.json({
      success: true,
      data: createSafeUser(user, getPublicServerBase(req))
    } as ApiResponse);

  } catch (error) {
    res.status(401).json({
      success: false,
      error: 'Invalid token'
    } as ApiResponse);
  }
});

// Helper function to ensure pigsail user exists and send welcome message
async function addPigsailAsFriendAndSendWelcome(newUser: any, publicBase: string) {
  const PIGSAIL_USERNAME = 'pigsail';
  const PIGSAIL_DISPLAY_NAME = 'PigSail';
  const WELCOME_MESSAGE = '你好，我是PigSail，PigSail的p，PigSail的Sail';

  try {
    // Check if pigsail user exists, create if not
    let pigsailUser = await dbStorage.getUserByUsername(PIGSAIL_USERNAME);

    if (!pigsailUser) {
      // Create pigsail user with a default password
      const pigsailPasswordHash = await hashPassword('pigsail123456'); // Default password
      pigsailUser = await dbStorage.createUser({
        username: PIGSAIL_USERNAME,
        displayName: PIGSAIL_DISPLAY_NAME,
        email: 'pigsail@example.com',
        passwordHash: pigsailPasswordHash,
        avatar: getPigsailAvatarUrl(publicBase)
      });
      console.log('Created pigsail user:', pigsailUser);
    }

    await ensurePigsailAvatarSynced(publicBase);
    const refreshed = await dbStorage.getUserByUsername(PIGSAIL_USERNAME);
    if (refreshed) pigsailUser = refreshed;

    // Check if private chat already exists between new user and pigsail
    const existingChat = await dbStorage.getPrivateChat(newUser.id, pigsailUser.id);

    if (!existingChat) {
      // Create private chat
      const chat = await dbStorage.createChat({
        type: 'private',
        participants: [newUser.id, pigsailUser.id]
      });

      // Create welcome message from pigsail
      const welcomeMessage: Message = {
        id: Math.random().toString(36).substr(2, 9) + Date.now().toString(36),
        senderId: pigsailUser.id,
        chatId: chat.id,
        content: WELCOME_MESSAGE,
        timestamp: new Date(),
        type: 'text',
        readBy: [pigsailUser.id], // Mark as read by sender, not by new user
        isEdited: false,
        isDeleted: false,
        reactions: {}
      };

      await dbStorage.addMessage(welcomeMessage);

      // Update chat's last message
      await dbStorage.updateChatLastMessage(chat.id, welcomeMessage);

      console.log(`Added pigsail as friend for user ${newUser.username} and sent welcome message`);
    }
  } catch (error) {
    console.error('Error in addPigsailAsFriendAndSendWelcome:', error);
    throw error;
  }
}

export default router;