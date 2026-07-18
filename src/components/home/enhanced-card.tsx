import { Box, Typography, alpha, useTheme } from '@mui/material'
import React, { forwardRef, ReactNode } from 'react'

// 自定义卡片组件接口
interface EnhancedCardProps {
  title: ReactNode
  icon: ReactNode
  action?: ReactNode
  children: ReactNode
  iconColor?: 'primary' | 'secondary' | 'error' | 'warning' | 'info' | 'success'
  minHeight?: number | string
  noContentPadding?: boolean
  backgroundImage?: string
}

// 自定义卡片组件
export const EnhancedCard = forwardRef<HTMLElement, EnhancedCardProps>(
  (
    {
      title,
      icon,
      action,
      children,
      iconColor = 'primary',
      minHeight,
      noContentPadding = false,
      backgroundImage,
    },
    ref,
  ) => {
    const theme = useTheme()
    const isDark = theme.palette.mode === 'dark'

    // 统一的标题截断样式
    const titleTruncateStyle = {
      minWidth: 0,
      maxWidth: '100%',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      display: 'block',
    }

    return (
      <Box
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: 2,
          backgroundColor: isDark ? '#282a36' : '#ffffff',
          ...(backgroundImage && {
            backgroundImage: `${
              isDark
                ? 'linear-gradient(90deg, rgba(17, 20, 34, 0.84) 0%, rgba(24, 28, 46, 0.54) 54%, rgba(30, 35, 57, 0.2) 100%)'
                : 'linear-gradient(90deg, rgba(250, 252, 255, 0.76) 0%, rgba(246, 249, 255, 0.44) 55%, rgba(241, 245, 255, 0.12) 100%)'
            }, url(${backgroundImage})`,
            backgroundSize: 'cover',
            backgroundPosition: 'right center',
          }),
        }}
        ref={ref}
      >
        <Box
          sx={{
            px: 2,
            py: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: 1,
            borderColor: 'divider',
            ...(backgroundImage && {
              backgroundColor: isDark
                ? 'rgba(17, 20, 34, 0.35)'
                : 'rgba(255, 255, 255, 0.28)',
              backdropFilter: 'blur(10px)',
            }),
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              flex: 1,
              overflow: 'hidden',
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 1.5,
                width: 38,
                height: 38,
                mr: 1.5,
                flexShrink: 0,
                backgroundColor: alpha(theme.palette[iconColor].main, 0.12),
                color: theme.palette[iconColor].main,
              }}
            >
              {icon}
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              {typeof title === 'string' ? (
                <Typography
                  variant="h6"
                  sx={{
                    ...titleTruncateStyle,
                    fontWeight: 'medium',
                    fontSize: 18,
                  }}
                  title={title}
                >
                  {title}
                </Typography>
              ) : (
                <Box sx={titleTruncateStyle}>{title}</Box>
              )}
            </Box>
          </Box>
          {action && <Box sx={{ ml: 2, flexShrink: 0 }}>{action}</Box>}
        </Box>
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            p: noContentPadding ? 0 : 2,
            ...(minHeight && { minHeight }),
          }}
        >
          {children}
        </Box>
      </Box>
    )
  },
)
