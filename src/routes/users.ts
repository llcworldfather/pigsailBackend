import express from 'express';
import { dbStorage } from '../utils/db-storage';
import { verifyToken } from '../utils/auth';
import { getPublicServerBase, normalizeAvatarUrl } from '../utils/public-url';
import { resolveAvatarInput } from '../utils/avatar-storage';
import { ApiResponse } from '../types';

const router = express.Router();

// Middleware to verify token
const authenticateToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'No token provided'
    } as ApiResponse);
  }

  try {
    const decoded = verifyToken(token);
    (req as any).user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Invalid token'
    } as ApiResponse);
  }
};

// Get all users
router.get('/', authenticateToken, async (req, res) => {
  try {
    const currentUserId = (req as any).user.id;
    const publicBase = getPublicServerBase(req);
    const allUsers = await dbStorage.getAllUsers();

    // Exclude current user and only return safe user data
    const users = allUsers
      .filter(user => user.id !== currentUserId)
      .map(user => ({
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatar: normalizeAvatarUrl(user.avatar, publicBase),
        status: user.status,
        lastSeen: user.lastSeen,
        joinedAt: user.joinedAt
      }));

    res.json({
      success: true,
      data: users
    } as ApiResponse);

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    } as ApiResponse);
  }
});

// Get user by ID
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const publicBase = getPublicServerBase(req);
    const user = await dbStorage.getUserById(id);

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      } as ApiResponse);
    }

    // Return safe user data
    const safeUser = {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatar: normalizeAvatarUrl(user.avatar, publicBase),
      status: user.status,
      lastSeen: user.lastSeen,
      joinedAt: user.joinedAt
    };

    res.json({
      success: true,
      data: safeUser
    } as ApiResponse);

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    } as ApiResponse);
  }
});


router.put('/:id', authenticateToken, async (req, res) => {
    try {
        const { displayName, avatar, email, password } = req.body;
        const currentUserId = (req as any).user.id;

        console.log(`Update profile request: URL ID=${req.params.id}, Token ID=${currentUserId}, URL=${req.originalUrl}`);

        // 只允许用户更新自己的信息
        if (req.params.id !== currentUserId) {
            console.log(`403 Forbidden: User ${currentUserId} trying to update user ${req.params.id}`);
            return res.status(403).json({
                success: false,
                error: 'You can only update your own profile',
                details: `Request user ID: ${req.params.id}, Token user ID: ${currentUserId}`
            } as ApiResponse);
        }

        const publicBase = getPublicServerBase(req);
        const updateData: any = { displayName };

        if (typeof avatar === 'string') {
            updateData.avatar = await resolveAvatarInput(avatar, { userId: currentUserId, kind: 'user' }, publicBase);
        } else if (avatar !== undefined) {
            updateData.avatar = avatar;
        }

        // 如果提供了密码，需要哈希处理（这里简化处理）
        if (password) {
            // 在实际应用中应该使用 bcrypt
            updateData.passwordHash = password; // 注意：实际应用中应该进行哈希处理
        }

        const updatedUser = await dbStorage.updateUser(req.params.id, updateData);

        if (!updatedUser) {
            return res.status(404).json({
                success: false,
                error: 'User not found'
            } as ApiResponse);
        }

        // 返回安全的用户数据（不包含密码哈希）
        const safeUser = {
            id: updatedUser.id,
            username: updatedUser.username,
            displayName: updatedUser.displayName,
            avatar: normalizeAvatarUrl(updatedUser.avatar, publicBase),
            email: updatedUser.email,
            status: updatedUser.status,
            lastSeen: updatedUser.lastSeen,
            joinedAt: updatedUser.joinedAt
        };

        res.json({
            success: true,
            data: safeUser
        } as ApiResponse);
    } catch (error) {
        console.error('Update user error:', error);
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('Invalid or oversized')) {
            return res.status(400).json({
                success: false,
                error: msg
            } as ApiResponse);
        }
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        } as ApiResponse);
    }
});


// Get online users
router.get('/online/list', authenticateToken, async (req, res) => {
  try {
    const publicBase = getPublicServerBase(req);
    const onlineUsers = dbStorage.getOnlineUsers();

    const safeUsers = onlineUsers.map(user => ({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      avatar: normalizeAvatarUrl(user.avatar, publicBase),
      status: user.status
    }));

    res.json({
      success: true,
      data: safeUsers
    } as ApiResponse);

  } catch (error) {
    console.error('Get online users error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error'
    } as ApiResponse);
  }
});

export default router;