import { NavLink } from 'react-router-dom';
import { LayoutDashboard, ListFilter, Clock, Settings, FolderOpen } from 'lucide-react';
import { Separator } from '@/components/ui/separator';
import { useI18n } from '@/context/I18nProvider';

export default function Sidebar() {
  const { t } = useI18n();

  const navItems = [
    { to: '/',         icon: LayoutDashboard, label: t('nav.dashboard') },
    { to: '/rules',    icon: ListFilter,      label: t('nav.rules')     },
    { to: '/activity', icon: Clock,           label: t('nav.activity')  },
  ];

  return (
    <aside className="w-52 border-r border-border bg-background flex flex-col shrink-0" data-testid="sidebar">

      {/* Logo */}
      <div className="p-5 pb-4">
        <div className="flex items-center gap-2.5">
          <FolderOpen className="w-5 h-5 text-foreground" strokeWidth={2} />
          <span className="text-lg font-semibold tracking-tight">Foldr</span>
        </div>
        <p className="text-[10px] tracking-[0.2em] uppercase text-muted-foreground mt-1.5">
          {t('nav.fileOrganizer')}
        </p>
      </div>

      <Separator />

      {/* Main nav */}
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

      {/* Settings pinned to bottom */}
      <div className="p-3">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex items-center gap-3 px-3 py-2.5 rounded-md text-xs tracking-[0.1em] font-medium transition-colors duration-200 ${
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`
          }
          data-testid="nav-settings"
        >
          <Settings className="w-4 h-4" strokeWidth={1.8} />
          {t('nav.settings')}
        </NavLink>
      </div>

    </aside>
  );
}