import { NavLink } from 'react-router-dom';
import { LayoutDashboard, ListFilter, Clock, Settings, FolderOpen, Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '@/context/ThemeProvider';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'DASHBOARD' },
  { to: '/rules', icon: ListFilter, label: 'RULES' },
  { to: '/activity', icon: Clock, label: 'ACTIVITY' },
  { to: '/settings', icon: Settings, label: 'SETTINGS' },
];

const themeOptions = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'System' },
];

export default function Sidebar() {
  const { theme, setTheme } = useTheme();
  const currentThemeOption = themeOptions.find(o => o.value === theme) || themeOptions[2];
  const ThemeIcon = currentThemeOption.icon;

  return (
    <aside className="w-52 border-r border-border bg-background flex flex-col shrink-0" data-testid="sidebar">
      <div className="p-5 pb-4">
        <div className="flex items-center gap-2.5">
          <FolderOpen className="w-5 h-5 text-foreground" strokeWidth={2} />
          <span className="text-lg font-semibold tracking-tight">Foldr</span>
        </div>
        <p className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground mt-1.5">
          FILE ORGANIZER
        </p>
      </div>

      <Separator />

      <nav className="flex-1 p-3 space-y-0.5" data-testid="sidebar-nav">
        {navItems.map(item => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-md text-xs tracking-[0.1em] font-medium transition-colors duration-200 ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`
            }
            data-testid={`nav-${item.label.toLowerCase()}`}
          >
            <item.icon className="w-4 h-4" strokeWidth={1.8} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <Separator />

      <div className="p-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start gap-3 text-xs tracking-[0.1em] text-muted-foreground hover:text-foreground"
              data-testid="theme-switcher"
            >
              <ThemeIcon className="w-4 h-4" strokeWidth={1.8} />
              {currentThemeOption.label.toUpperCase()}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-40">
            {themeOptions.map(opt => (
              <DropdownMenuItem
                key={opt.value}
                onClick={() => setTheme(opt.value)}
                className="gap-2 text-xs"
                data-testid={`theme-${opt.value}`}
              >
                <opt.icon className="w-3.5 h-3.5" />
                {opt.label}
                {theme === opt.value && <span className="ml-auto text-foreground">&#10003;</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </aside>
  );
}
