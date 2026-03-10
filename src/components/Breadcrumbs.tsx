import React from "react";

import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

interface BreadcrumbsProps {
  crumbs: { label: string; onClick?: () => void }[];
}

export function Breadcrumbs({ crumbs }: BreadcrumbsProps) {
  return (
    <Breadcrumb className="breadcrumbs">
      {crumbs.length > 0 && (
        <BreadcrumbList>
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            return (
              <React.Fragment key={crumb.label}>
                <BreadcrumbItem>
                  {crumb.onClick ? (
                    <BreadcrumbLink
                      className="cursor-pointer"
                      role="button"
                      tabIndex={0}
                      onClick={crumb.onClick}
                    >
                      {crumb.label}
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
                {!isLast && <BreadcrumbSeparator />}
              </React.Fragment>
            );
          })}
        </BreadcrumbList>
      )}
    </Breadcrumb>
  );
}
